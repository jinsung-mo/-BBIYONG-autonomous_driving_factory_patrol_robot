package com.bbiyong.server.robot.service;

import com.bbiyong.server.robot.dto.RobotRecoveryResponse;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 관제 이벤트 로그의 '복구' 버튼 → 로봇의 {@code ~/calib/nav2_recover.sh}.
 *
 * <p>이 명령은 로봇의 Nav2 코어를 <b>통째로 내렸다 올린다.</b> 도는 동안 주행이 불가능하고,
 * 순찰 중이었다면 순찰이 끊긴다(로봇이 먼저 주행을 정상 정지시킨 뒤 재기동한다).
 * 그래서 자동으로 부르지 않는다 — 사람이 로그를 보고 확인한 뒤에만 부른다
 * (사용자 지침 2026-08-10: "planner 자동복구는 켜지 않는다").
 *
 * <p>전송 방식은 {@code SET_PATROL_ROUTE} 와 같다: 로봇 WSS 세션으로 명령 JSON 을 내린다
 * ({@link RobotWebSocketSessionManager#sendCommand}). 진행 상황은 로봇이 되돌려 주는
 * 조용한 시스템 로그 이벤트(PLANNER_RECOVER_STARTED / _OK / _FAILED)로 확인한다.
 */
@Slf4j
@Service
public class RobotRecoveryService {

    /**
     * 같은 로봇에 대한 재요청을 막는 시간. 로봇 쪽 실측이 없어(2026-08-10 기준 드라이런까지만
     * 검증됨) 스크립트가 잡고 있는 상한(정지 30초 + 준비대기 60초)에 여유를 더한 값이다.
     * 로봇도 자체적으로 단일 실행을 보장하지만, 두 겹으로 막는 이유는 버튼 연타가
     * 그대로 "막 띄운 nav2 를 다시 죽이는" 명령이 되기 때문이다.
     */
    private static final Duration RECOVERY_COOLDOWN = Duration.ofSeconds(180);

    private final RobotWebSocketSessionManager sessionManager;
    private final ConcurrentHashMap<String, Instant> lastRequested = new ConcurrentHashMap<>();

    public RobotRecoveryService(RobotWebSocketSessionManager sessionManager) {
        this.sessionManager = sessionManager;
    }

    public RobotRecoveryResponse recoverNav2(String robotId) {
        String rid = robotId == null ? "" : robotId.trim();
        if (rid.isEmpty()) {
            return new RobotRecoveryResponse("INVALID", false, "robotId 가 필요합니다.");
        }
        if (!sessionManager.isConnected(rid)) {
            return new RobotRecoveryResponse("OFFLINE", false,
                    "로봇이 연결되어 있지 않습니다. 연결된 뒤 다시 시도하세요.");
        }

        Instant now = Instant.now();
        Instant previous = lastRequested.get(rid);
        if (previous != null && Duration.between(previous, now).compareTo(RECOVERY_COOLDOWN) < 0) {
            long remaining = RECOVERY_COOLDOWN.getSeconds() - Duration.between(previous, now).getSeconds();
            return new RobotRecoveryResponse("IN_PROGRESS", false,
                    "복구가 이미 진행 중입니다. 약 " + Math.max(remaining, 1) + "초 뒤에 다시 시도하세요.");
        }
        // 하달 전에 선점한다. 뒤에 잡으면 두 요청이 동시에 통과할 수 있다.
        if (previous != null ? !lastRequested.replace(rid, previous, now)
                             : lastRequested.putIfAbsent(rid, now) != null) {
            return new RobotRecoveryResponse("IN_PROGRESS", false, "복구가 이미 진행 중입니다.");
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("command", "NAV2_RECOVER");
        payload.put("robot_id", rid);
        boolean delivered = sessionManager.sendCommand(rid, payload);
        if (!delivered) {
            // 하달 실패는 시도한 적 없는 것과 같다 — 쿨다운을 풀어 즉시 재시도할 수 있게 한다.
            lastRequested.remove(rid, now);
            log.warn("NAV2_RECOVER not delivered (robot [{}] offline)", rid);
            return new RobotRecoveryResponse("OFFLINE", false,
                    "로봇에 명령을 전달하지 못했습니다.");
        }
        log.info("NAV2_RECOVER dispatched to robot [{}]", rid);
        return new RobotRecoveryResponse("ACCEPTED", true,
                "Nav2 재기동을 시작했습니다. 진행 상황은 이벤트 로그에 남습니다.");
    }
}
