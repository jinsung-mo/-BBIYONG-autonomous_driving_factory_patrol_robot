package com.bbiyong.server.map.service;

import com.bbiyong.server.map.dto.MappingStatusResponse;
import com.bbiyong.server.wss.event.RobotMappingCompleteEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 온디맨드 매핑 진행 상태(로봇별)를 보관·브로드캐스트한다. (S15P11E101-737 후속)
 *
 * <p>관제 대시보드 "지도" 탭은 매핑이 진행 중이면 실시간 SLAM 대신 "매핑중" 화면을 띄우고,
 * 완료되면 3D 도면으로 전환한다. 이를 위해 두 가지가 필요하다:
 * <ul>
 *   <li><b>실시간 전환 신호</b>: {@code /topic/mapping} 으로 {@code MAPPING_STATUS} 푸시
 *       (start 시 {@code phase=MAPPING}, stop/complete 시 {@code phase=IDLE}).</li>
 *   <li><b>새로고침 복원</b>: 중간에 접속하거나 새로고침한 클라이언트가 현재 상태를 알 수 있도록
 *       {@code GET /api/maps/status} 조회 제공.</li>
 * </ul>
 *
 * <p>완료는 기존 {@code FLOORPLAN_READY}(도면 준비됨) 신호가 별도로 알리므로,
 * 본 서비스의 phase 는 진행 여부(MAPPING/IDLE)만 다룬다.
 *
 * <p>상태 전이는 운영자 명령 발행 시점(START/STOP_MAPPING)과 로봇 완료 이벤트로 갱신한다.
 * START 는 낙관적으로 즉시 MAPPING 으로 전환하며, 로봇이 거부하면 운영자가 STOP 으로 초기화한다.
 */
@Slf4j
@Service
public class MappingStatusService {

    public enum Phase { IDLE, MAPPING }

    private record State(Phase phase, Instant since) {}

    private final Map<String, State> states = new ConcurrentHashMap<>();
    private final SimpMessagingTemplate messagingTemplate;
    private final ObjectMapper objectMapper;

    public MappingStatusService(SimpMessagingTemplate messagingTemplate, ObjectMapper objectMapper) {
        this.messagingTemplate = messagingTemplate;
        this.objectMapper = objectMapper;
    }

    /** START_MAPPING 발행 시: 매핑 진행 중으로 전환하고 관제에 알린다. */
    public void markMapping(String robotId) {
        transition(robotId, Phase.MAPPING);
    }

    /** STOP_MAPPING 발행 시: 매핑 중단(진행 아님)으로 전환하고 관제에 알린다. */
    public void markIdle(String robotId) {
        transition(robotId, Phase.IDLE);
    }

    /** 로봇 매핑 완료 수신 시: 진행 종료(IDLE)로 전환한다. 도면 준비는 FLOORPLAN_READY 가 별도 통지. */
    @EventListener
    public void onMappingComplete(RobotMappingCompleteEvent event) {
        transition(event.getRobotId(), Phase.IDLE);
    }

    /** 현재 매핑 진행 여부. */
    public boolean isMapping(String robotId) {
        State s = states.get(robotId);
        return s != null && s.phase() == Phase.MAPPING;
    }

    /** 새로고침·중간접속 클라이언트용 현재 상태 스냅샷. 미기록 로봇은 IDLE. */
    public MappingStatusResponse snapshot(String robotId) {
        State s = states.get(robotId);
        Phase phase = s != null ? s.phase() : Phase.IDLE;
        Instant since = s != null ? s.since() : null;
        return new MappingStatusResponse(robotId, phase.name(), phase == Phase.MAPPING, since);
    }

    private void transition(String robotId, Phase phase) {
        if (robotId == null || robotId.isBlank()) {
            return;
        }
        states.put(robotId, new State(phase, Instant.now()));
        broadcast(robotId, phase);
    }

    private void broadcast(String robotId, Phase phase) {
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("type", "MAPPING_STATUS");
            payload.put("robotId", robotId);
            payload.put("phase", phase.name());
            payload.put("mapping", phase == Phase.MAPPING);
            messagingTemplate.convertAndSend("/topic/mapping", objectMapper.writeValueAsString(payload));
            log.info("Broadcast MAPPING_STATUS phase={} for robot [{}]", phase, robotId);
        } catch (Exception e) {
            log.error("Failed to broadcast MAPPING_STATUS for robot [{}]", robotId, e);
        }
    }
}
