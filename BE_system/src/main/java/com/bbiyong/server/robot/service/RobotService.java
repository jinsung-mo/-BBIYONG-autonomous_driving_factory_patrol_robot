package com.bbiyong.server.robot.service;

import com.bbiyong.server.robot.domain.Location;
import com.bbiyong.server.robot.domain.RobotState;
import com.bbiyong.server.robot.dto.RobotResponse;
import com.bbiyong.server.robot.repository.RobotStateCache;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotTelemetryEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.stream.Collectors;

@Slf4j
@Service
public class RobotService {

    private final RobotStateCache stateCache;

    public RobotService(RobotStateCache stateCache) {
        this.stateCache = stateCache;
    }

    public List<RobotResponse> getAllRobots() {
        return stateCache.getAllStates().stream()
                .map(state -> new RobotResponse(
                        state.getRobotId(),
                        state.getName(),
                        state.getStatus(),
                        state.getBattery(),
                        state.getLastConnected(),
                        state.getLocation()
                ))
                .collect(Collectors.toList());
    }

    @EventListener
    public void handleTelemetry(RobotTelemetryEvent event) {
        RobotPacket packet = event.getPacket();
        if (packet == null || packet.getRobotId() == null) {
            return;
        }

        String robotId = packet.getRobotId();
        RobotState state = stateCache.getState(robotId);
        if (state == null) {
            state = new RobotState();
            state.setRobotId(robotId);
            state.setName("순찰로봇 " + robotId);
        }

        state.setStatus(packet.getStatus());
        state.setBattery(packet.getBattery());
        state.setLastConnected(Instant.now());

        if (packet.getLocation() != null) {
            state.setLocation(new Location(
                    packet.getLocation().getX(),
                    packet.getLocation().getY(),
                    packet.getLocation().getYaw()
            ));
        }

        stateCache.updateState(robotId, state);
        log.debug("Updated cached state for robot {}: status={}, battery={}", 
                robotId, state.getStatus(), state.getBattery());
    }
}
