package com.bbiyong.server.event.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.AlertMessage;
import com.bbiyong.server.event.dto.EventFilterRequest;
import com.bbiyong.server.event.dto.EventLogDetailResponse;
import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.event.repository.EventLogSpecification;
import com.bbiyong.server.notification.service.NotificationDispatchService;
import com.bbiyong.server.video.dto.VideoResponses;
import com.bbiyong.server.video.repository.VideoClipRepository;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import com.bbiyong.server.wss.event.SimulatedRobotFireEvent;
import com.bbiyong.server.wss.event.SimulatedRobotOverheatEvent;
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
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Slf4j
@Service
public class EventLogService {

    private static final Set<String> ALLOWED_STATUS = Set.of("UNRESOLVED", "RESOLVED");

    private final EventLogRepository eventLogRepository;
    private final NotificationDispatchService notificationDispatchService;
    private final VideoClipRepository videoClipRepository;
    private final RobotWebSocketSessionManager sessionManager;

    public EventLogService(
            EventLogRepository eventLogRepository,
            NotificationDispatchService notificationDispatchService,
            VideoClipRepository videoClipRepository,
            RobotWebSocketSessionManager sessionManager) {
        this.eventLogRepository = eventLogRepository;
        this.notificationDispatchService = notificationDispatchService;
        this.videoClipRepository = videoClipRepository;
        this.sessionManager = sessionManager;
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

    /**
     * 고급 필터링을 지원하는 이벤트 조회
     */
    @Transactional(readOnly = true)
    public EventPageResponse getEventsWithFilters(
            int page, int size,
            String type, String level, String status,
            String robotId, String equipmentId,
            String startDate, String endDate) {

        // 필터 객체 생성
        EventFilterRequest filter = new EventFilterRequest();
        filter.setType(type);
        filter.setLevel(level);
        filter.setStatus(status);
        filter.setRobotId(robotId);
        filter.setEquipmentId(equipmentId);

        // 날짜 파싱
        if (startDate != null && !startDate.isBlank()) {
            try {
                filter.setStartDate(LocalDate.parse(startDate));
            } catch (Exception e) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "잘못된 시작 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.");
            }
        }
        if (endDate != null && !endDate.isBlank()) {
            try {
                filter.setEndDate(LocalDate.parse(endDate));
            } catch (Exception e) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "잘못된 종료 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.");
            }
        }

        // Specification 기반 동적 쿼리 실행
        Pageable pageable = PageRequest.of(page, size, Sort.by(Sort.Direction.DESC, "timestamp"));
        Page<EventLog> result = eventLogRepository.findAll(
                EventLogSpecification.withFilters(filter),
                pageable
        );

        return EventPageResponse.from(result);
    }

    /**
     * 이벤트 로그 상세 조회 (연관 영상 정보 포함)
     */
    @Transactional(readOnly = true)
    public EventLogDetailResponse getEventDetail(Long eventId) {
        EventLog event = eventLogRepository.findById(eventId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "이벤트를 찾을 수 없습니다."));

        // 연관 영상 조회
        List<VideoResponses.Summary> videos = videoClipRepository
                .findByEventIdOrderByStartedAtDesc(eventId)
                .stream()
                .map(VideoResponses.Summary::of)
                .toList();

        return EventLogDetailResponse.from(event, videos);
    }

    /**
     * 이벤트에 영상이 존재하는지 확인
     */
    @Transactional(readOnly = true)
    public boolean hasVideo(Long eventId) {
        return videoClipRepository.existsByEventId(eventId);
    }

    @EventListener
    public void handleFireEvent(RobotFireEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromFire(event.getPacket()), event instanceof SimulatedRobotFireEvent simulated
                ? simulated.getRecipientUserId() : null);
    }

    @EventListener
    public void handleOverheatEvent(RobotOverheatEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromOverheat(event.getPacket()), event instanceof SimulatedRobotOverheatEvent simulated
                ? simulated.getRecipientUserId() : null);
    }

    /**
     * 실시간 경보(AlertMessage)와 동일한 필드로 이력을 영속화한다.
     * (열화상 thermalImage 는 설계상 미저장)
     */
    public void persistSimulation(AlertMessage alert, String recipientUserId) {
        persist(alert, recipientUserId);
    }

    private void persist(AlertMessage alert, String simulationRecipientUserId) {
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
        logEntry.setSimulated("SIMULATION".equals(alert.source()));

        EventLog savedEvent = eventLogRepository.save(logEntry);
        log.info("Persisted {} event log for robot: {}", alert.type(), alert.robotId());

        // 이벤트 클립 연결을 위해 로봇에 생성된 eventId 를 회신한다(블랙박스 파이프라인). (S15P11E101-588)
        notifyRobotEventSaved(savedEvent);

        notificationDispatchService.enqueue(savedEvent, simulationRecipientUserId);
    }

    /**
     * 이벤트 저장 직후, 로봇에게 생성된 {@code eventId} 를 EVENT_SAVED 로 회신한다.
     *
     * <p>로봇은 회신받은 eventId 로 {@code POST /api/videos/upload?eventId=..&clipType=EVENT}
     * 업로드해 이벤트-클립을 연결한다(설계문서 §3 옵션1). 로봇 미연결/전송 실패는 이벤트
     * 영속화에 영향을 주지 않도록 조용히 로깅만 한다.
     */
    private void notifyRobotEventSaved(EventLog event) {
        String robotId = event.getRobotId();
        if (robotId == null || robotId.isBlank()) {
            return;
        }
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("command", "EVENT_SAVED");
            payload.put("eventId", event.getEventId());
            payload.put("type", event.getType());
            boolean sent = sessionManager.sendCommand(robotId, payload);
            if (!sent) {
                log.warn("EVENT_SAVED 회신 실패(로봇 미연결): robot={}, eventId={}", robotId, event.getEventId());
            }
        } catch (Exception e) {
            log.error("EVENT_SAVED 회신 중 오류: robot={}, eventId={}, error={}",
                    robotId, event.getEventId(), e.getMessage(), e);
        }
    }

}
