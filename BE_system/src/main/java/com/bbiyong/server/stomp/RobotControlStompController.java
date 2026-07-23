package com.bbiyong.server.stomp;

import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.stereotype.Controller;

import java.util.Map;

@Slf4j
@Controller
public class RobotControlStompController {

    private final RobotWebSocketSessionManager robotWssSessionManager;

    public RobotControlStompController(RobotWebSocketSessionManager robotWssSessionManager) {
        this.robotWssSessionManager = robotWssSessionManager;
    }

    @MessageMapping("/control/drive")
    public void handleDriveCommand(Map<String, Object> payload) {
        String robotId = (String) payload.get("robot_id");
        if (robotId == null) {
            robotId = "orinka_01";
        }
        log.info("Received STOMP Drive Command for [{}]: {}", robotId, payload);
        boolean sent = robotWssSessionManager.sendCommand(robotId, payload);
        if (!sent) {
            log.warn("Failed to relay STOMP drive command to robot WSS session: {}", robotId);
        }
    }

    @MessageMapping("/control/mode")
    public void handleModeCommand(Map<String, Object> payload) {
        String robotId = (String) payload.get("robot_id");
        if (robotId == null) {
            robotId = "orinka_01";
        }
        log.info("Received STOMP Mode Command for [{}]: {}", robotId, payload);
        robotWssSessionManager.sendCommand(robotId, payload);
    }

    @MessageMapping("/control/dispatch")
    public void handleDispatchCommand(Map<String, Object> payload) {
        String robotId = (String) payload.get("robot_id");
        if (robotId == null) {
            robotId = "orinka_01";
        }
        log.info("Received STOMP Dispatch Command for [{}]: {}", robotId, payload);
        robotWssSessionManager.sendCommand(robotId, payload);
    }
}
