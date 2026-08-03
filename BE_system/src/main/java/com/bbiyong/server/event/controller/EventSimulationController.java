package com.bbiyong.server.event.controller;

import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.SimulatedRobotFireEvent;
import com.bbiyong.server.wss.event.SimulatedRobotOverheatEvent;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

@RestController
@RequestMapping("/api/admin/event-simulations")
@PreAuthorize("hasRole('ADMIN')")
public class EventSimulationController {
    private static final Duration COOLDOWN = Duration.ofSeconds(5);

    private final ApplicationEventPublisher publisher;
    private final boolean enabled;
    private final Clock clock;
    private final ConcurrentHashMap<String, Instant> lastSimulationAt = new ConcurrentHashMap<>();

    // 운영에서는 UTC 시스템 시간을 쓴다. 테스트만 별도 Clock으로 경계 시점을 고정한다.
    @Autowired
    public EventSimulationController(ApplicationEventPublisher publisher,
            @Value("${bbiyong.event.simulation.enabled:false}") boolean enabled) {
        this(publisher, enabled, Clock.systemUTC());
    }

    EventSimulationController(ApplicationEventPublisher publisher, boolean enabled, Clock clock) {
        this.publisher = publisher;
        this.enabled = enabled;
        this.clock = clock;
    }

    @PostMapping("/{type}") @ResponseStatus(HttpStatus.ACCEPTED)
    public void simulate(@AuthenticationPrincipal String userId, @PathVariable String type) {
        if (!enabled) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        String normalizedType = type.toUpperCase(Locale.ROOT);
        if (!"FIRE".equals(normalizedType) && !"OVERHEAT".equals(normalizedType)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "FIRE 또는 OVERHEAT만 지원합니다.");
        }
        enforceCooldown(userId, normalizedType);

        RobotPacket p = packet(normalizedType);
        if ("FIRE".equals(normalizedType)) publisher.publishEvent(new SimulatedRobotFireEvent(this, p, userId));
        else publisher.publishEvent(new SimulatedRobotOverheatEvent(this, p, userId));
    }

    private void enforceCooldown(String userId, String type) {
        String key = userId + ':' + type;
        Instant now = clock.instant();
        AtomicBoolean accepted = new AtomicBoolean(false);
        // compute 안에서 판정과 저장을 같이 해 동시에 두 요청이 통과하지 않게 한다.
        lastSimulationAt.compute(key, (ignored, previous) -> {
            if (previous == null || !previous.plus(COOLDOWN).isAfter(now)) {
                accepted.set(true);
                return now;
            }
            return previous;
        });
        if (!accepted.get()) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "같은 테스트 이벤트는 5초 후 다시 발생시킬 수 있습니다.");
        }
    }

    private RobotPacket packet(String type) {
        RobotPacket p = new RobotPacket(); p.setSource("SIMULATION"); p.setRobotId("demo_robot"); p.setType("EVENT_" + type.toUpperCase());
        RobotPacket.Location l = new RobotPacket.Location(); l.setX(10.0); l.setY(20.0); p.setLocation(l);
        if ("FIRE".equalsIgnoreCase(type)) { p.setConfidence(0.95); p.setTemperature(65.0); }
        else { p.setEquipmentId("demo_panel"); p.setTemperature(85.0); p.setThreshold(55.0); }
        return p;
    }
}
