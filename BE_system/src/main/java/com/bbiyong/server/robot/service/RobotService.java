package com.bbiyong.server.robot.service;

import com.bbiyong.server.robot.domain.Location;
import com.bbiyong.server.robot.domain.RobotState;
import com.bbiyong.server.robot.dto.RobotResponse;
import com.bbiyong.server.robot.repository.RobotStateCache;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotDisconnectedEvent;
import com.bbiyong.server.wss.event.RobotTelemetryEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

@Slf4j
@Service
public class RobotService {

    /** 오프라인으로 판정할 무수신 임계 시간. 이 시간 넘게 텔레메트리가 없으면 offline. */
    static final Duration TELEMETRY_TIMEOUT = Duration.ofSeconds(15);
    static final String OFFLINE_STATUS = "OFFLINE";

    private final RobotStateCache stateCache;
    private final RobotWebSocketSessionManager sessionManager;
    private final ApplicationEventPublisher eventPublisher;

    public RobotService(RobotStateCache stateCache,
                        RobotWebSocketSessionManager sessionManager,
                        ApplicationEventPublisher eventPublisher) {
        this.stateCache = stateCache;
        this.sessionManager = sessionManager;
        this.eventPublisher = eventPublisher;
    }

    public List<RobotResponse> getAllRobots() {
        // 캐시(과거 수신 상태)와 현재 열린 세션을 합집합으로 노출한다.
        Set<String> robotIds = new LinkedHashSet<>();
        stateCache.getAllStates().forEach(s -> robotIds.add(s.getRobotId()));
        robotIds.addAll(sessionManager.getConnectedRobotIds());

        Instant now = Instant.now();
        List<RobotResponse> responses = new ArrayList<>();
        for (String robotId : robotIds) {
            RobotState state = stateCache.getState(robotId);
            boolean online = sessionManager.isConnected(robotId);
            boolean fresh = state != null && isFresh(state.getLastConnected(), now);
            // 신선한 텔레메트리가 있을 때만 보고된 상태를 노출하고, 그 외에는 OFFLINE.
            String status = fresh ? state.getStatus() : OFFLINE_STATUS;

            responses.add(new RobotResponse(
                    robotId,
                    robotId,
                    status,
                    state != null ? state.getBattery() : null,
                    state != null ? state.getSpeed() : null,
                    state != null ? state.getEstop() : null,
                    state != null ? state.getCommLatencyMs() : null,
                    state != null ? state.getInferenceFps() : null,
                    state != null ? state.getLastConnected() : null,
                    state != null ? state.getLocation() : null,
                    online
            ));
        }
        return responses;
    }

    private boolean isFresh(Instant lastConnected, Instant now) {
        return lastConnected != null
                && Duration.between(lastConnected, now).compareTo(TELEMETRY_TIMEOUT) < 0;
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
        }
        state.setName(robotId);

        state.setStatus(packet.getStatus());
        state.setBattery(packet.getBattery());
        state.setSpeed(packet.getSpeed());
        state.setEstop(packet.getEstop());
        state.setCommLatencyMs(packet.getCommLatencyMs());
        state.setInferenceFps(packet.getInferenceFps());
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

    /** 세션 종료/타임아웃으로 오프라인이 되면 캐시 상태를 OFFLINE 으로 낮춘다. */
    @EventListener
    public void handleDisconnect(RobotDisconnectedEvent event) {
        RobotState state = stateCache.getState(event.getRobotId());
        if (state != null && !OFFLINE_STATUS.equals(state.getStatus())) {
            state.setStatus(OFFLINE_STATUS);
            stateCache.updateState(event.getRobotId(), state);
            log.info("Robot [{}] marked OFFLINE", event.getRobotId());
        }
    }

    /**
     * 텔레메트리 타임아웃 스윕: 세션 close 이벤트를 놓친(무음 단절) 로봇도
     * 일정 시간 무수신이면 OFFLINE 으로 낮추고 상태변경을 전파한다.
     */
    @Scheduled(fixedDelay = 5000)
    public void sweepStaleRobots() {
        Instant now = Instant.now();
        for (RobotState state : stateCache.getAllStates()) {
            boolean stale = !isFresh(state.getLastConnected(), now);
            if (stale && !OFFLINE_STATUS.equals(state.getStatus())) {
                eventPublisher.publishEvent(new RobotDisconnectedEvent(this, state.getRobotId()));
            }
        }
    }
}
