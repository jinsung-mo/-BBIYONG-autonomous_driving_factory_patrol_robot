package com.bbiyong.server.tcp;

import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
public class TcpSessionManager {

    private final Map<String, TcpClientHandler> sessions = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper;

    public TcpSessionManager(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    public void register(String robotId, TcpClientHandler handler) {
        if (robotId == null || robotId.trim().isEmpty()) {
            return;
        }
        sessions.put(robotId, handler);
        log.info("Registered TCP session for robot: {}", robotId);
    }

    public void unregister(String robotId) {
        if (robotId == null) {
            return;
        }
        if (sessions.remove(robotId) != null) {
            log.info("Unregistered TCP session for robot: {}", robotId);
        }
    }

    public boolean sendCommand(String robotId, Object commandPayload) {
        TcpClientHandler handler = sessions.get(robotId);
        if (handler == null) {
            log.warn("Cannot send command. No active TCP session found for robot: {}", robotId);
            return false;
        }

        try {
            String jsonStr = objectMapper.writeValueAsString(commandPayload);
            handler.sendMessage(jsonStr);
            log.info("Sent TCP command to {}: {}", robotId, jsonStr);
            return true;
        } catch (Exception e) {
            log.error("Failed to send TCP command to robot {}: {}", robotId, e.getMessage(), e);
            return false;
        }
    }

    public boolean isConnected(String robotId) {
        return sessions.containsKey(robotId);
    }

    public void closeAll() {
        log.info("Closing all active TCP sessions...");
        sessions.forEach((robotId, handler) -> {
            try {
                handler.close();
            } catch (Exception e) {
                log.error("Error closing session for robot {}: {}", robotId, e.getMessage());
            }
        });
        sessions.clear();
    }
}
