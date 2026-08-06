package com.bbiyong.server.stomp;

import com.bbiyong.server.stomp.dto.InspectionCommand;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.stereotype.Controller;

import java.security.Principal;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * 웹 대시보드의 AprilTag 점검 지점 명령(/app/control/inspection)을 검증·인가 후 로봇 WSS 로 중계한다.
 * (S15P11E101-778)
 *
 * <p>로봇 계약(inspection_point_command)을 그대로 따른다: command 는
 * CONFIRM | REJECT | UPDATE | DELETE | PUBLISH.
 * <ul>
 *   <li>CONFIRM/REJECT → candidateId 필요</li>
 *   <li>UPDATE/DELETE → pointId 필요, CONFIRM/UPDATE 는 name(선택, 128자 클램프)</li>
 *   <li>PUBLISH → 인자 없음(전체 목록 재발행 요청)</li>
 * </ul>
 *
 * <p><b>인가</b>: 점검 지점 편집은 운영 행위이므로 {@code ROLE_ADMIN} 만 허용한다(제어 명령과 동일 기준).
 * 다만 주행이 아니라 조종 점유(lease)는 적용하지 않는다 — 두 관리자가 서로 다른 지점을 동시에
 * 편집하는 것은 정상이다.
 */
@Slf4j
@Controller
public class InspectionStompController {

    private static final String DEFAULT_ROBOT_ID = "orinka_01";
    private static final Set<String> VALID_COMMANDS =
            Set.of("CONFIRM", "REJECT", "UPDATE", "DELETE", "PUBLISH");
    private static final Set<String> CONTROL_AUTHORITIES = Set.of("ROLE_ADMIN");
    private static final int MAX_NAME_LEN = 128;

    private final RobotWebSocketSessionManager sessionManager;

    public InspectionStompController(RobotWebSocketSessionManager sessionManager) {
        this.sessionManager = sessionManager;
    }

    @MessageMapping("/control/inspection")
    public void inspection(InspectionCommand cmd, Principal principal) {
        String robotId = resolveRobotId(cmd);
        if (!hasControlAuthority(principal)) {
            log.warn("점검 명령 거부(권한 없음): user[{}] robot[{}] command[{}]",
                    nameOf(principal), robotId, cmd.getCommand());
            return;
        }
        String command = cmd.getCommand() != null ? cmd.getCommand().toUpperCase() : null;
        if (command == null || !VALID_COMMANDS.contains(command)) {
            drop(cmd, "유효하지 않은 command: " + cmd.getCommand());
            return;
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("schemaVersion", 1);
        payload.put("kind", "inspection_point_command");
        payload.put("command", command);

        switch (command) {
            case "CONFIRM", "REJECT" -> {
                if (isBlank(cmd.getCandidateId())) {
                    drop(cmd, command + " 는 candidateId 가 필요합니다.");
                    return;
                }
                payload.put("candidateId", cmd.getCandidateId());
                if (command.equals("CONFIRM")) {
                    putNameIfPresent(payload, cmd.getName());
                }
            }
            case "UPDATE", "DELETE" -> {
                if (isBlank(cmd.getPointId())) {
                    drop(cmd, command + " 는 pointId 가 필요합니다.");
                    return;
                }
                payload.put("pointId", cmd.getPointId());
                if (command.equals("UPDATE")) {
                    putNameIfPresent(payload, cmd.getName());
                }
            }
            default -> {
                // PUBLISH: 추가 인자 없음
            }
        }
        relay(robotId, payload);
    }

    private void putNameIfPresent(Map<String, Object> payload, String name) {
        if (!isBlank(name)) {
            payload.put("name", name.trim().substring(0, Math.min(name.trim().length(), MAX_NAME_LEN)));
        }
    }

    private void relay(String robotId, Map<String, Object> payload) {
        boolean delivered = sessionManager.sendCommand(robotId, payload);
        if (!delivered) {
            log.warn("Inspection command not delivered (robot [{}] offline): {}", robotId, payload);
        }
    }

    private boolean hasControlAuthority(Principal principal) {
        if (!(principal instanceof Authentication authentication)) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(CONTROL_AUTHORITIES::contains);
    }

    private String resolveRobotId(InspectionCommand cmd) {
        return (cmd.getRobotId() != null && !cmd.getRobotId().isBlank())
                ? cmd.getRobotId() : DEFAULT_ROBOT_ID;
    }

    private String nameOf(Principal principal) {
        return principal != null ? principal.getName() : null;
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private void drop(InspectionCommand cmd, String reason) {
        log.warn("Dropping invalid inspection command from web (robot [{}]): {} — {}",
                cmd.getRobotId(), cmd.getCommand(), reason);
    }
}
