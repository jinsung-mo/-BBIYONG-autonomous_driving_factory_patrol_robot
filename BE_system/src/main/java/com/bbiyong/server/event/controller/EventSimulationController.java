package com.bbiyong.server.event.controller;

import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.SimulatedRobotFireEvent;
import com.bbiyong.server.wss.event.SimulatedRobotOverheatEvent;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/admin/event-simulations")
@PreAuthorize("hasRole('ADMIN')")
public class EventSimulationController {
    private final ApplicationEventPublisher publisher;
    private final boolean enabled;
    public EventSimulationController(ApplicationEventPublisher publisher,
            @Value("${bbiyong.event.simulation.enabled:false}") boolean enabled) {
        this.publisher = publisher; this.enabled = enabled;
    }
    @PostMapping("/{type}") @ResponseStatus(HttpStatus.ACCEPTED)
    public void simulate(@AuthenticationPrincipal String userId, @PathVariable String type) {
        if (!enabled) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        RobotPacket p = packet(type);
        if ("FIRE".equalsIgnoreCase(type)) publisher.publishEvent(new SimulatedRobotFireEvent(this, p, userId));
        else if ("OVERHEAT".equalsIgnoreCase(type)) publisher.publishEvent(new SimulatedRobotOverheatEvent(this, p, userId));
        else throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "FIRE 또는 OVERHEAT만 지원합니다.");
    }
    private RobotPacket packet(String type) {
        RobotPacket p = new RobotPacket(); p.setSource("SIMULATION"); p.setRobotId("demo_robot"); p.setType("EVENT_" + type.toUpperCase());
        RobotPacket.Location l = new RobotPacket.Location(); l.setX(10.0); l.setY(20.0); p.setLocation(l);
        if ("FIRE".equalsIgnoreCase(type)) { p.setConfidence(0.95); p.setTemperature(65.0); }
        else { p.setEquipmentId("demo_panel"); p.setTemperature(85.0); p.setThreshold(55.0); }
        return p;
    }
}
