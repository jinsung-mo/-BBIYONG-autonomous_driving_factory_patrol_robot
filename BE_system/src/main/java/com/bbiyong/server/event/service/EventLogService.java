package com.bbiyong.server.event.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.AlertMessage;
import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;

@Slf4j
@Service
public class EventLogService {

    private final EventLogRepository eventLogRepository;

    public EventLogService(EventLogRepository eventLogRepository) {
        this.eventLogRepository = eventLogRepository;
    }

    @Transactional(readOnly = true)
    public EventPageResponse getEvents(int page, int size, String type) {
        Pageable pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "timestamp"));
        Page<EventLog> result = (type == null || type.isBlank())
                ? eventLogRepository.findAll(pageable)
                : eventLogRepository.findByType(type.trim().toUpperCase(), pageable);
        return EventPageResponse.from(result);
    }

    @EventListener
    public void handleFireEvent(RobotFireEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromFire(event.getPacket()));
    }

    @EventListener
    public void handleOverheatEvent(RobotOverheatEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromOverheat(event.getPacket()));
    }

    /**
     * 실시간 경보(AlertMessage)와 동일한 필드로 이력을 영속화한다.
     * (열화상 thermalImage 는 설계상 미저장)
     */
    private void persist(AlertMessage alert) {
        EventLog logEntry = new EventLog();
        logEntry.setType(alert.type());
        logEntry.setLevel(alert.level());
        logEntry.setMessage(alert.message());
        logEntry.setRobotId(alert.robotId());
        logEntry.setConfidence(alert.confidence());
        logEntry.setTemperature(alert.temperature());
        logEntry.setEquipmentId(alert.equipmentId());
        logEntry.setThreshold(alert.threshold());
        logEntry.setX(alert.x());
        logEntry.setY(alert.y());
        logEntry.setTimestamp(Instant.now());
        logEntry.setStatus("UNRESOLVED");

        eventLogRepository.save(logEntry);
        log.info("Persisted {} event log for robot: {}", alert.type(), alert.robotId());
    }
}
