package com.bbiyong.server.stomp;

import com.bbiyong.server.stomp.dto.ControlCommand;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.stereotype.Controller;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * 웹 대시보드 STOMP 제어 명령(/app/control/*)을 검증 후 로봇 WSS 세션으로 중계한다.
 *
 * <p>로봇 명령 계약(ground truth: remote_control_protocol)을 그대로 따른다.
 * <ul>
 *   <li>/app/control/drive → DRIVE(linear, angular) — manual 모드에서 유효</li>
 *   <li>/app/control/mode → SET_MODE(autonomy|manual|disabled) 또는 ESTOP(active=true)</li>
 *   <li>/app/control/operation → START_MAPPING / STOP_MAPPING / NAVIGATE(x, y, yaw) / SAVE_MAP(name)</li>
 *   <li>/app/control/camera → CAMERA_TILT(tilt) — 전면 카메라 상하 절대각(degrees), 가동범위로 클램프</li>
 * </ul>
 * 순찰 복귀는 별도 명령이 아니라 SET_MODE mode=autonomy 로 처리한다(로봇 프로토콜에 RESUME 없음).
 */
@Slf4j
@Controller
public class RobotControlStompController {

    private static final String DEFAULT_ROBOT_ID = "orinka_01";
    private static final Set<String> VALID_MODES = Set.of("autonomy", "manual", "disabled");

    private final RobotWebSocketSessionManager sessionManager;

    /** 전면 카메라 tilt 가동 범위(절대각, degrees). FE 는 동일 범위로 버튼 잠금/현재각을 표시한다. */
    private final double tiltMin;
    private final double tiltMax;

    public RobotControlStompController(
            RobotWebSocketSessionManager sessionManager,
            @Value("${bbiyong.camera.tilt-min:-30.0}") double tiltMin,
            @Value("${bbiyong.camera.tilt-max:45.0}") double tiltMax) {
        this.sessionManager = sessionManager;
        this.tiltMin = tiltMin;
        this.tiltMax = tiltMax;
    }

    @MessageMapping("/control/drive")
    public void drive(ControlCommand cmd) {
        double linear = cmd.getLinear() != null ? cmd.getLinear() : 0.0;
        double angular = cmd.getAngular() != null ? cmd.getAngular() : 0.0;
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("command", "DRIVE");
        payload.put("linear", linear);
        payload.put("angular", angular);
        relay(cmd, payload);
    }

    @MessageMapping("/control/mode")
    public void mode(ControlCommand cmd) {
        if ("ESTOP".equalsIgnoreCase(cmd.getCommand())) {
            // fail-safe: 활성화(active=true)만 허용
            if (!Boolean.TRUE.equals(cmd.getActive())) {
                drop(cmd, "ESTOP active 는 true 만 허용됩니다.");
                return;
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("command", "ESTOP");
            payload.put("active", true);
            relay(cmd, payload);
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
    public void operation(ControlCommand cmd) {
        String command = cmd.getCommand();
        if ("START_MAPPING".equalsIgnoreCase(command)) {
            // 로봇에게 "자율주행하며 2D 맵 생성 시작"을 요청. 실제 SLAM/자율주행은 로봇 측에서 수행.
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("command", "START_MAPPING");
            relay(cmd, payload);
            return;
        }
        if ("STOP_MAPPING".equalsIgnoreCase(command)) {
            // 진행 중인 자율탐색 매핑 중단 요청.
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("command", "STOP_MAPPING");
            relay(cmd, payload);
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
    public void camera(ControlCommand cmd) {
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

    private void relay(ControlCommand cmd, Map<String, Object> payload) {
        String robotId = (cmd.getRobotId() != null && !cmd.getRobotId().isBlank())
                ? cmd.getRobotId() : DEFAULT_ROBOT_ID;
        boolean delivered = sessionManager.sendCommand(robotId, payload);
        if (!delivered) {
            log.warn("Control command not delivered (robot [{}] offline): {}", robotId, payload);
        }
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
