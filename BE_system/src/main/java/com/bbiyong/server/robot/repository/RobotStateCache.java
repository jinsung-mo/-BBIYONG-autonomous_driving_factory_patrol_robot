package com.bbiyong.server.robot.repository;

import com.bbiyong.server.robot.domain.RobotState;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class RobotStateCache {
    private final Map<String, RobotState> cache = new ConcurrentHashMap<>();

    public RobotStateCache() {
        // Pre-populate with the default robot from the specification
        RobotState defaultRobot = new RobotState();
        defaultRobot.setRobotId("orinka_01");
        defaultRobot.setName("순찰로봇 오린카 1호기");
        defaultRobot.setStatus("AUTO_PATROL");
        defaultRobot.setBattery(92.5);
        defaultRobot.setLastConnected(java.time.Instant.now());
        defaultRobot.setLocation(new com.bbiyong.server.robot.domain.Location(1.25, 3.40, 0.78));
        cache.put("orinka_01", defaultRobot);
    }

    public void updateState(String robotId, RobotState state) {
        cache.put(robotId, state);
    }

    public RobotState getState(String robotId) {
        return cache.get(robotId);
    }

    public List<RobotState> getAllStates() {
        return new ArrayList<>(cache.values());
    }
}
