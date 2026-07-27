package com.bbiyong.server.stomp;

import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.stereotype.Controller;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

@Slf4j
@Controller
public class RobotControlStompController {

    private static final String DEFAULT_ROBOT_ID = "orinka_01";
    private static final Pattern ROBOT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final Pattern MAP_NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_-]{0,63}");
    private final RobotWebSocketSessionManager robotWssSessionManager;

    public RobotControlStompController(RobotWebSocketSessionManager robotWssSessionManager) {
        this.robotWssSessionManager = robotWssSessionManager;
    }

    @MessageMapping("/control/drive")
    public void handleDriveCommand(Map<String, Object> payload) {
        relay("DRIVE", payload);
    }

    @MessageMapping("/control/mode")
    public void handleModeCommand(Map<String, Object> payload) {
        relay("MODE", payload);
    }

    @MessageMapping("/control/operation")
    public void handleOperationCommand(Map<String, Object> payload) {
        relay("OPERATION", payload);
    }

    private void relay(String endpoint, Map<String, Object> payload) {
        Map<String, Object> command = validate(endpoint, payload);
        if (command == null) {
            log.warn("Rejected invalid STOMP {} payload", endpoint);
            return;
        }
        String robotId = (String) command.get("robot_id");
        if (!robotWssSessionManager.sendCommand(robotId, command)) {
            log.warn("Failed to relay {} command to robot {}", command.get("command"), robotId);
        }
    }

    static Map<String, Object> validate(String endpoint, Map<String, Object> payload) {
        if (payload == null || payload.get("command") == null) return null;
        String robotId = stringOrDefault(payload.get("robot_id"), DEFAULT_ROBOT_ID);
        if (!ROBOT_ID.matcher(robotId).matches()) return null;
        String command = payload.get("command") instanceof String value ? value.toUpperCase() : "";
        Map<String, Object> safe = new LinkedHashMap<>();
        safe.put("robot_id", robotId);
        safe.put("command", command);
        if ("DRIVE".equals(endpoint) && "DRIVE".equals(command)) {
            Double linear = finite(payload.get("linear"));
            Double angular = finite(payload.get("angular"));
            if (linear == null || angular == null) return null;
            safe.put("linear", linear); safe.put("angular", angular); return safe;
        }
        if ("MODE".equals(endpoint) && ("SET_MODE".equals(command) || "ESTOP".equals(command))) {
            if ("ESTOP".equals(command)) { safe.put("active", true); return safe; }
            String mode = stringOrDefault(payload.get("mode"), "").toLowerCase();
            if (!mode.matches("disabled|manual|autonomy")) return null;
            safe.put("mode", mode); return safe;
        }
        if ("OPERATION".equals(endpoint) && "SAVE_MAP".equals(command)) {
            String name = stringOrDefault(payload.get("name"), "");
            if (!MAP_NAME.matcher(name).matches()) return null;
            safe.put("name", name); return safe;
        }
        if ("OPERATION".equals(endpoint) && "NAVIGATE".equals(command)) {
            Double x = finite(payload.get("x")); Double y = finite(payload.get("y")); Double yaw = finite(payload.get("yaw"));
            if (x == null || y == null || yaw == null) return null;
            safe.put("x", x); safe.put("y", y); safe.put("yaw", yaw); return safe;
        }
        return null;
    }

    private static String stringOrDefault(Object value, String fallback) {
        return value instanceof String text && !text.isBlank() ? text : fallback;
    }

    private static Double finite(Object value) {
        if (!(value instanceof Number number)) return null;
        double converted = number.doubleValue();
        return Double.isFinite(converted) ? converted : null;
    }
}
