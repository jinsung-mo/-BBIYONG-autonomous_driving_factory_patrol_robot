package com.bbiyong.server.event.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.tcp.dto.RobotPacket;
import com.bbiyong.server.tcp.event.RobotFireEvent;
import com.bbiyong.server.tcp.event.RobotOverheatEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.time.Instant;

@Slf4j
@Service
public class EventLogService {

    private final EventLogRepository eventLogRepository;

    public EventLogService(EventLogRepository eventLogRepository) {
        this.eventLogRepository = eventLogRepository;
    }

    @EventListener
    public void handleFireEvent(RobotFireEvent event) {
        RobotPacket packet = event.getPacket();
        if (packet == null) {
            return;
        }

        EventLog logEntry = new EventLog();
        logEntry.setType("FIRE");
        logEntry.setRobotId(packet.getRobotId());
        logEntry.setConfidence(packet.getConfidence());
        logEntry.setTemperature(packet.getTemperature());
        logEntry.setTimestamp(Instant.now());
        logEntry.setStatus("UNRESOLVED");

        if (packet.getLocation() != null) {
            logEntry.setX(packet.getLocation().getX());
            logEntry.setY(packet.getLocation().getY());
        }

        eventLogRepository.save(logEntry);
        log.info("Persisted Fire Event Log for robot: {}", packet.getRobotId());
    }

    @EventListener
    public void handleOverheatEvent(RobotOverheatEvent event) {
        RobotPacket packet = event.getPacket();
        if (packet == null) {
            return;
        }

        EventLog logEntry = new EventLog();
        logEntry.setType("OVERHEAT");
        logEntry.setRobotId(packet.getRobotId());
        logEntry.setTemperature(packet.getTemperature());
        logEntry.setTimestamp(Instant.now());
        logEntry.setStatus("UNRESOLVED");

        if (packet.getLocation() != null) {
            logEntry.setX(packet.getLocation().getX());
            logEntry.setY(packet.getLocation().getY());
        }

        eventLogRepository.save(logEntry);
        log.info("Persisted Overheat Event Log for robot: {}", packet.getRobotId());
    }
}
