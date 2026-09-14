package com.bbiyong.server.stomp;

import com.bbiyong.server.equipment.service.EquipmentService;
import com.bbiyong.server.stomp.dto.InspectionCommand;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.stereotype.Controller;
import tools.jackson.databind.ObjectMapper;

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

    /** 웹 대시보드 점검 지점 토픽 — 로봇 업링크 relay(RobotEventListener)와 같은 토픽을 쓴다. */
    static final String INSPECTION_TOPIC = "/topic/inspection";

    private final RobotWebSocketSessionManager sessionManager;
    private final SimpMessagingTemplate messagingTemplate;
    private final ObjectMapper objectMapper;
    private final EquipmentService equipmentService;

    public InspectionStompController(RobotWebSocketSessionManager sessionManager,
                                     SimpMessagingTemplate messagingTemplate,
                                     ObjectMapper objectMapper,
                                     EquipmentService equipmentService) {
        this.sessionManager = sessionManager;
        this.messagingTemplate = messagingTemplate;
        this.objectMapper = objectMapper;
        this.equipmentService = equipmentService;
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
                    // 승인한 점검 지점을 감시 설비로 등록한다(S15P11E101) — 곧바로 '분전반 임계온도'
                    // 목록에 나타나 임계온도를 설정할 수 있다. 좌표(target)는 실려 오면 함께 저장한다.
                    InspectionCommand.Target t = cmd.getTarget();
                    equipmentService.registerInspectionEquipment(
                            cmd.getCandidateId(), cmd.getName(),
                            t != null ? t.getX() : null,
                            t != null ? t.getY() : null);
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
                    // '순찰 제외' 토글과 순서 변경도 UPDATE 로 온다 — 빠뜨리면 로봇에
                    // 이름만 전달되고 토글이 조용히 무시된다.
                    if (cmd.getEnabled() != null) {
                        payload.put("enabled", cmd.getEnabled());
                    }
                    if (cmd.getSequence() != null) {
                        payload.put("sequence", cmd.getSequence());
                    }
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
        echoToWeb(payload);
    }

    /**
     * 검증을 통과한 명령을 웹 토픽에도 그대로 되쏜다.
     *
     * <p>점검 지점 상태는 서버가 저장하지 않는 relay 구조라, 승인(CONFIRM) 결과가 다른
     * 접속자·다른 탭에 보이려면 로봇이 확정 목록을 되올려 줄 때까지 기다려야 했다.
     * 모든 클라이언트는 후보를 이미 {@code /topic/inspection} 으로 받아 갖고 있으므로,
     * 명령만 되쏘면 각자 같은 전이(후보→확정 등)를 로컬에서 재현할 수 있다.
     * 로봇이 오프라인이어도 되쏜다 — 로봇이 재접속해 스냅샷을 올리면 그 값으로 다시 맞는다.
     */
    private void echoToWeb(Map<String, Object> payload) {
        try {
            messagingTemplate.convertAndSend(INSPECTION_TOPIC, objectMapper.writeValueAsString(payload));
        } catch (Exception e) {
            log.error("Inspection command echo 실패: {}", payload, e);
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
