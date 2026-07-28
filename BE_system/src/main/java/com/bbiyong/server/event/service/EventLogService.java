package com.bbiyong.server.event.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.Set;

@Slf4j
@Service
public class EventLogService {

    private static final Set<String> ALLOWED_STATUS = Set.of("UNRESOLVED", "RESOLVED");

    private final EventLogRepository eventLogRepository;

    public EventLogService(EventLogRepository eventLogRepository) {
        this.eventLogRepository = eventLogRepository;
    }

    /**
     * 경보(이벤트) 상태 전이(UNRESOLVED &lt;-&gt; RESOLVED). 관제사가 경보를 처리완료로 표시한다.
     *
     * @throws ResponseStatusException 허용되지 않은 status(400) 또는 미존재 이벤트(404)
     */
    @Transactional
    public EventLog updateStatus(Long eventId, String status) {
        String normalized = status == null ? null : status.trim().toUpperCase();
        if (normalized == null || !ALLOWED_STATUS.contains(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "유효하지 않은 status 입니다. (UNRESOLVED | RESOLVED)");
        }
        EventLog event = eventLogRepository.findById(eventId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "이벤트를 찾을 수 없습니다."));
        event.setStatus(normalized);
        return eventLogRepository.save(event);
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
