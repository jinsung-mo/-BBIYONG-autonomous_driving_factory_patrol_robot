package com.bbiyong.server.stomp;

import com.bbiyong.server.map.service.MappingStatusService;
import com.bbiyong.server.stomp.dto.ControlCommand;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.stereotype.Controller;

import java.security.Principal;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * 웹 대시보드 STOMP 제어 명령(/app/control/*)을 검증 후 로봇 WSS 세션으로 중계한다.
 *
 * <p>로봇 명령 계약(ground truth: remote_control_protocol)을 그대로 따른다.
 * <ul>
 *   <li>/app/control/drive → DRIVE(linear, angular) — manual 모드에서 유효</li>
 *   <li>/app/control/mode → SET_MODE(autonomy|manual|disabled)</li>
 *   <li>/app/control/operation → START_MAPPING / STOP_MAPPING / NAVIGATE(x, y, yaw) / SAVE_MAP(name)</li>
 *   <li>/app/control/camera → CAMERA_TILT(tilt) — 전면 카메라 상하 절대각(degrees), 가동범위로 클램프</li>
 * </ul>
 * 순찰 복귀는 별도 명령이 아니라 SET_MODE mode=autonomy 로 처리한다(로봇 프로토콜에 RESUME 없음).
 *
 * <p><b>인가</b>: CONNECT 시 {@link StompAuthChannelInterceptor} 가 붙여 준 principal 을 매 명령마다
 * 확인해 {@code ROLE_ADMIN} 이 아닌 사용자의 명령은 드롭한다. FE 의 canOperate 는 화면 잠금일 뿐
 * 브라우저에서 STOMP 프레임을 직접 쏘면 우회되므로, 서버가 실제 게이트다.
 */
@Slf4j
@Controller
public class RobotControlStompController {

    private static final String DEFAULT_ROBOT_ID = "orinka_01";
    private static final Set<String> VALID_MODES = Set.of("autonomy", "manual", "disabled");

    /** 로봇 제어가 허용되는 권한. 그 외(ROLE_USER 등)는 조회만 가능하다. */
    private static final Set<String> CONTROL_AUTHORITIES = Set.of("ROLE_ADMIN");

    private final RobotWebSocketSessionManager sessionManager;
    private final MappingStatusService mappingStatusService;

    /** 전면 카메라 tilt 가동 범위(절대각, degrees). FE 는 동일 범위로 버튼 잠금/현재각을 표시한다. */
    private final double tiltMin;
    private final double tiltMax;

    public RobotControlStompController(
            RobotWebSocketSessionManager sessionManager,
            MappingStatusService mappingStatusService,
            @Value("${bbiyong.camera.tilt-min:-30.0}") double tiltMin,
            @Value("${bbiyong.camera.tilt-max:45.0}") double tiltMax) {
        this.sessionManager = sessionManager;
        this.mappingStatusService = mappingStatusService;
        this.tiltMin = tiltMin;
        this.tiltMax = tiltMax;
    }

    @MessageMapping("/control/drive")
    public void drive(ControlCommand cmd, Principal principal) {
        if (!authorize(cmd, principal)) {
            return;
        }
        double linear = cmd.getLinear() != null ? cmd.getLinear() : 0.0;
        double angular = cmd.getAngular() != null ? cmd.getAngular() : 0.0;
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("command", "DRIVE");
        payload.put("linear", linear);
        payload.put("angular", angular);
        relay(cmd, payload);
    }

    @MessageMapping("/control/mode")
    public void mode(ControlCommand cmd, Principal principal) {
        if (!authorize(cmd, principal)) {
            return;
        }
        String mode = cmd.getMode();
        if (mode == null || !VALID_MODES.contains(mode)) {
            drop(cmd, "유효하지 않은 mode: " + mode);
            return;
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("command", "SET_MODE");
        payload.put("mode", mode);
        relay(cmd, payload);
    }

    @MessageMapping("/control/operation")
    public void operation(ControlCommand cmd, Principal principal) {
        if (!authorize(cmd, principal)) {
            return;
        }
        String command = cmd.getCommand();
        if ("START_MAPPING".equalsIgnoreCase(command)) {
            // 로봇에게 "자율주행하며 2D 맵 생성 시작"을 요청. 실제 SLAM/자율주행은 로봇 측에서 수행.
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("command", "START_MAPPING");
            relay(cmd, payload);
            // 지도 탭이 "매핑중" 화면으로 전환하도록 진행 상태를 갱신·브로드캐스트한다. (낙관적)
            mappingStatusService.markMapping(resolveRobotId(cmd));
            return;
        }
        if ("STOP_MAPPING".equalsIgnoreCase(command)) {
            // 진행 중인 자율탐색 매핑 중단 요청.
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("command", "STOP_MAPPING");
            relay(cmd, payload);
            mappingStatusService.markIdle(resolveRobotId(cmd));
            return;
        }
        if ("SAVE_MAP".equalsIgnoreCase(command)) {
            String name = safeBasename(cmd.getName());
            if (name == null) {
                drop(cmd, "유효하지 않은 맵 이름: " + cmd.getName());
                return;
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("command", "SAVE_MAP");
            payload.put("name", name);
            relay(cmd, payload);
            return;
        }
        if ("NAVIGATE".equalsIgnoreCase(command)) {
            if (cmd.getX() == null || cmd.getY() == null) {
                drop(cmd, "NAVIGATE 는 x, y 가 필요합니다.");
                return;
            }
            double yaw = cmd.getYaw() != null ? cmd.getYaw() : 0.0;
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("command", "NAVIGATE");
            payload.put("x", cmd.getX());
            payload.put("y", cmd.getY());
            payload.put("yaw", yaw);
            relay(cmd, payload);
            return;
        }
        drop(cmd, "알 수 없는 operation command: " + command);
    }

    @MessageMapping("/control/camera")
    public void camera(ControlCommand cmd, Principal principal) {
        if (!authorize(cmd, principal)) {
            return;
        }
        // 전면 카메라 상하 각도(절대각, degrees). 로봇 프로토콜: CAMERA_TILT{tilt}.
        if (cmd.getTilt() == null) {
            drop(cmd, "CAMERA_TILT 는 tilt(절대각 degrees) 가 필요합니다.");
            return;
        }
        double clamped = Math.max(tiltMin, Math.min(tiltMax, cmd.getTilt()));
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("command", "CAMERA_TILT");
        payload.put("tilt", clamped);
        relay(cmd, payload);
    }

    /**
     * 제어 명령 1건에 대한 인가 관문. principal 이 없거나 {@code ROLE_ADMIN} 이 아니면 드롭한다.
     *
     * <p>principal 은 STOMP CONNECT 에서 JWT 를 검증한 {@link StompAuthChannelInterceptor} 가
     * 세션에 붙여 준 것이다. 그동안 이 값을 읽지 않아 ROLE_USER 도 로봇을 조종할 수 있었다.
     */
    private boolean authorize(ControlCommand cmd, Principal principal) {
        if (hasControlAuthority(principal)) {
            return true;
        }
        log.warn("제어 명령 거부(권한 없음): user[{}] robot[{}] command[{}]",
                principal != null ? principal.getName() : null, resolveRobotId(cmd), cmd.getCommand());
        return false;
    }

    /** principal 이 로봇 제어 권한을 갖는지. STOMP CONNECT 시 부여된 authority 를 그대로 본다. */
    private boolean hasControlAuthority(Principal principal) {
        if (!(principal instanceof Authentication authentication)) {
            return false;
        }
        return authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .anyMatch(CONTROL_AUTHORITIES::contains);
    }

    private void relay(ControlCommand cmd, Map<String, Object> payload) {
        String robotId = resolveRobotId(cmd);
        boolean delivered = sessionManager.sendCommand(robotId, payload);
        if (!delivered) {
            log.warn("Control command not delivered (robot [{}] offline): {}", robotId, payload);
        }
    }

    /** 명령의 robot_id 를 해석한다(미지정 시 기본 로봇). */
    private String resolveRobotId(ControlCommand cmd) {
        return (cmd.getRobotId() != null && !cmd.getRobotId().isBlank())
                ? cmd.getRobotId() : DEFAULT_ROBOT_ID;
    }

    private void drop(ControlCommand cmd, String reason) {
        log.warn("Dropping invalid control command from web (robot [{}]): {} — {}",
                cmd.getRobotId(), cmd.getCommand(), reason);
    }

    /**
     * SAVE_MAP name 을 안전한 basename 으로 정제한다.
     * 경로 구분자 제거 후 영숫자/밑줄/하이픈만 허용하며, 비면 null.
     */
    private String safeBasename(String raw) {
        if (raw == null) {
            return null;
        }
        String base = raw.replaceAll(".*[/\\\\]", "");   // 경로 앞부분 제거
        String sanitized = base.replaceAll("[^A-Za-z0-9_-]", "");
        return sanitized.isBlank() ? null : sanitized;
    }
}
