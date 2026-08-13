package com.bbiyong.server.event.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.AlertMessage;
import com.bbiyong.server.event.dto.EventFilterRequest;
import com.bbiyong.server.event.dto.EventLogDetailResponse;
import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.event.repository.EventLogSpecification;
import com.bbiyong.server.common.config.AsyncConfig;
import com.bbiyong.server.map.service.MapService;
import com.bbiyong.server.notification.service.NotificationDispatchService;
import com.bbiyong.server.video.dto.VideoResponses;
import com.bbiyong.server.video.repository.VideoClipRepository;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import com.bbiyong.server.wss.event.RobotConnectedEvent;
import com.bbiyong.server.wss.event.RobotDisconnectedEvent;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotCautionEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import com.bbiyong.server.wss.event.RobotSystemLogEvent;
import com.bbiyong.server.video.event.EventClipRequestedEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.scheduling.annotation.Async;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.Duration;
import java.time.LocalDate;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Slf4j
@Service
public class EventLogService {

    // ACKNOWLEDGED(확인됨·조치 진행 중) 포함 — API 문서와 일치. (S15P11E101-715)
    private static final Set<String> ALLOWED_STATUS = Set.of("UNRESOLVED", "ACKNOWLEDGED", "RESOLVED");
    private static final Duration ALERT_DEDUP_WINDOW = Duration.ofMinutes(10);

    /**
     * 로봇이 올릴 수 있는 조용한 시스템 로그 코드. 이 값이 그대로 이벤트의 {@code type} 이
     * 되므로 화이트리스트로 막는다 — 로봇이 실수로 "FIRE" 를 보내면 관제의 화재 필터·
     * 통계·아이콘이 전부 그것을 화재로 센다.
     */
    private static final Set<String> ALLOWED_SYSTEM_LOG_CODES = Set.of(
            "PLANNER_DOWN",             // planner 생존 게이트 실패 — 복구가 필요하다
            "PLANNER_RECOVER_STARTED",  // 관제의 복구 버튼으로 Nav2 재기동 시작
            "PLANNER_RECOVER_OK",
            "PLANNER_RECOVER_FAILED",
            "PLANNER_RECOVER_BUSY");

    private final EventLogRepository eventLogRepository;
    private final NotificationDispatchService notificationDispatchService;
    private final VideoClipRepository videoClipRepository;
    private final RobotWebSocketSessionManager sessionManager;
    private final AlertBroadcastService alertBroadcastService;
    // 경보 좌표가 '어느 지도의 좌표인지' 기록하기 위해서만 쓴다(재매핑 잔상 제거).
    private final MapService mapService;
    private final ApplicationEventPublisher eventPublisher;
    private final ConcurrentHashMap<String, Instant> recentRobotAlerts = new ConcurrentHashMap<>();

    // 로봇 연결/해제를 SYSTEM 이벤트로 남길지(기본 on). 로봇별 마지막 연결상태를 들고 상태
    // 전이만 기록한다 — 세션 종료와 타임아웃 스윕이 해제 이벤트를 중복 발행해도 한 번만 남긴다.
    @Value("${bbiyong.event.log-robot-connection:true}")
    private boolean robotConnectionLogEnabled;
    private final ConcurrentHashMap<String, Boolean> robotConnected = new ConcurrentHashMap<>();

    public EventLogService(
            EventLogRepository eventLogRepository,
            NotificationDispatchService notificationDispatchService,
            VideoClipRepository videoClipRepository,
            RobotWebSocketSessionManager sessionManager,
            AlertBroadcastService alertBroadcastService,
            MapService mapService,
            ApplicationEventPublisher eventPublisher) {
        this.eventLogRepository = eventLogRepository;
        this.notificationDispatchService = notificationDispatchService;
        this.videoClipRepository = videoClipRepository;
        this.sessionManager = sessionManager;
        this.alertBroadcastService = alertBroadcastService;
        this.mapService = mapService;
        this.eventPublisher = eventPublisher;
    }

    /**
     * 경보(이벤트) 상태 전이(UNRESOLVED | ACKNOWLEDGED | RESOLVED). 관제사가 경보 확인/처리완료를 표시한다.
     *
     * @throws ResponseStatusException 허용되지 않은 status(400) 또는 미존재 이벤트(404)
     */
    @Transactional
    public EventLog updateStatus(Long eventId, String status) {
        String normalized = status == null ? null : status.trim().toUpperCase();
        if (normalized == null || !ALLOWED_STATUS.contains(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "유효하지 않은 status 입니다. (UNRESOLVED | ACKNOWLEDGED | RESOLVED)");
        }
        EventLog event = eventLogRepository.findById(eventId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "이벤트를 찾을 수 없습니다."));
        event.setStatus(normalized);
        return eventLogRepository.save(event);
    }

    /**
     * 이벤트(경보) 이력 삭제. 테스트/더미로 유입된 이벤트 정리용. 미존재 시 404.
     * 연관 영상(video_clips.event_id)은 유지되며 참조만 남는다.
     */
    @Transactional
    public void delete(Long eventId) {
        if (!eventLogRepository.existsById(eventId)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "이벤트를 찾을 수 없습니다.");
        }
        eventLogRepository.deleteById(eventId);
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

    // @Async: 경보 영속화(DB write)를 WSS 수신 스레드에서 분리한다. 커넥션 풀(개발 SQLite 1개)
    // 경합 시 텔레메트리·영상 프레임 처리가 함께 막히는 것을 방지한다. 단일 스레드 executor 로
    // 수신 순서·dedup 직렬성은 보존된다. (S15P11E101-715)
    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleFireEvent(RobotFireEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromFire(event.getPacket()), null);
    }

    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleOverheatEvent(RobotOverheatEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromOverheat(event.getPacket()), null);
    }

    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleCautionEvent(RobotCautionEvent event) {
        if (event.getPacket() == null) {
            return;
        }
        persist(AlertMessage.fromCaution(event.getPacket()), null);
    }

    /**
     * 로봇이 올린 <b>조용한 시스템 로그</b>(EVENT_SYSTEM).
     *
     * <p>🔴 일부러 {@link #persist} 를 타지 않는다. persist 는 {@code /topic/alerts} 방송과
     * {@code NotificationDispatchService} 발송을 함께 하므로, 그 길로 보내면 관제에 토스트와
     * 경보음이 뜬다. 사용자 지침(2026-08-10)은 "소리나 알림이 갈 필요는 없다. 정말 로그만
     * 보여달라" 이므로, 로봇 연결/해제 로그와 같은 조용한 경로({@link #saveSystemEvent})를 쓴다.
     *
     * <p>중복 억제는 두 겹이다. 1차는 로봇이 한다(같은 사건은 10분에 한 번). 2차가
     * {@code message_id} 의 DB unique 제약이며, 재연결로 같은 패킷이 두 번 올라오는 경우를 막는다.
     */
    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleSystemLogEvent(RobotSystemLogEvent event) {
        var packet = event.getPacket();
        if (packet == null) {
            return;
        }
        String code = packet.getCode() == null ? null : packet.getCode().trim().toUpperCase();
        if (code == null || !ALLOWED_SYSTEM_LOG_CODES.contains(code)) {
            log.warn("Dropping system log with unknown code=[{}] from robot [{}]",
                    packet.getCode(), packet.getRobotId());
            return;
        }
        String messageId = packet.getMessageId() == null ? null : packet.getMessageId().trim();
        if (messageId != null && !messageId.isEmpty()
                && eventLogRepository.findByMessageId(messageId).isPresent()) {
            log.info("Suppressing duplicate system log messageId={}", messageId);
            return;
        }
        String message = packet.getMessage() == null || packet.getMessage().isBlank()
                ? code : packet.getMessage().trim();
        try {
            saveSystemEvent(packet.getRobotId(), code, message,
                    messageId == null || messageId.isEmpty() ? null : messageId);
        } catch (DataIntegrityViolationException duplicate) {
            log.info("Suppressing concurrently persisted system log messageId={}", messageId);
        }
    }

    /**
     * 로봇 연결 — SYSTEM 이벤트로 남긴다. 이벤트 탭 '시스템' 필터에서 연결 이력을 볼 수 있다.
     * 상태 전이(연결 안됨 → 연결됨)일 때만 기록해 재연결·중복 발행을 걸러낸다.
     */
    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleRobotConnected(RobotConnectedEvent event) {
        if (!robotConnectionLogEnabled) {
            return;
        }
        String robotId = event.getRobotId();
        if (Boolean.TRUE.equals(robotConnected.put(robotId, Boolean.TRUE))) {
            return; // 이미 연결됨으로 기록됨
        }
        saveSystemEvent(robotId, "로봇 " + robotId + " 연결됨");
    }

    /**
     * 로봇 연결 해제 — SYSTEM 이벤트로 남긴다.
     * 세션 종료와 타임아웃 스윕이 해제 이벤트를 각각 발행하므로, 상태 전이일 때만 한 번 기록한다.
     */
    @Async(AsyncConfig.ALERT_EXECUTOR)
    @EventListener
    public void handleRobotDisconnected(RobotDisconnectedEvent event) {
        if (!robotConnectionLogEnabled) {
            return;
        }
        String robotId = event.getRobotId();
        if (Boolean.FALSE.equals(robotConnected.put(robotId, Boolean.FALSE))) {
            return; // 이미 연결 끊김으로 기록됨(중복 발행 방지)
        }
        saveSystemEvent(robotId, "로봇 " + robotId + " 연결 끊김");
    }

    /** 정보성 SYSTEM 이벤트 저장(연결/해제 로그 등). 조치 대상이 아니므로 status=RESOLVED. */
    private void saveSystemEvent(String robotId, String message) {
        saveSystemEvent(robotId, "SYSTEM", message, null);
    }

    /**
     * 정보성 이벤트 저장. <b>방송하지 않고 알림도 보내지 않는다</b> — 이것이 "조용한 로그" 의 정의다.
     *
     * <p>{@code status=RESOLVED} 인 이유: 관제 대시보드의 '미해결' 카드는
     * {@code /api/dashboard/stats} 의 unresolvedEvents 를 세는데, UNRESOLVED 로 넣으면
     * 그 카드가 노랗게 변한다 — 소리만 없을 뿐 경보처럼 보인다. 복구 버튼은 status 가 아니라
     * {@code type} 을 보고 뜨므로 RESOLVED 여도 조작에 지장이 없다.
     *
     * @param type      이벤트 종류. 호출자가 화이트리스트로 검증한 값이어야 한다.
     * @param messageId 중복 방지 키(DB unique). 없으면 null.
     */
    private void saveSystemEvent(String robotId, String type, String message, String messageId) {
        EventLog entry = new EventLog();
        entry.setType(type);
        entry.setLevel("INFO");
        entry.setRobotId(robotId);
        entry.setMessage(message);
        entry.setMessageId(messageId);
        entry.setTimestamp(Instant.now());
        entry.setStatus("RESOLVED");
        entry.setSimulated(false);
        if (messageId == null) {
            eventLogRepository.save(entry);
        } else {
            eventLogRepository.saveAndFlush(entry);
        }
        log.info("{} event logged: {}", type, message);
    }

    private void persist(AlertMessage alert, String simulationRecipientUserId) {
        String messageId = normalizeMessageId(alert);
        if (messageId != null && eventLogRepository.findByMessageId(messageId).isPresent()) {
            log.info("Suppressing duplicate {} alert with messageId={}", alert.type(), messageId);
            return;
        }
        DeduplicationAttempt deduplication = acquireDeduplication(alert);
        if (deduplication.duplicate()) {
            log.info("Suppressing duplicate {} alert for robot {} within {} seconds",
                    alert.type(), alert.robotId(), ALERT_DEDUP_WINDOW.toSeconds());
            return;
        }

        EventLog logEntry = new EventLog();
        logEntry.setType(alert.type());
        logEntry.setLevel(alert.level());
        logEntry.setMessage(alert.message());
        logEntry.setRobotId(alert.robotId());
        logEntry.setMessageId(normalizeMessageId(alert));
        logEntry.setConfidence(alert.confidence());
        logEntry.setTemperature(alert.temperature());
        logEntry.setEquipmentId(alert.equipmentId());
        logEntry.setThreshold(alert.threshold());
        logEntry.setX(alert.x());
        logEntry.setY(alert.y());
        logEntry.setMapId(currentMapId());
        logEntry.setTimestamp(Instant.parse(alert.timestamp()));
        logEntry.setStatus("UNRESOLVED");
        logEntry.setSimulated("SIMULATION".equals(alert.source()));

        EventLog savedEvent;
        try {
            savedEvent = hasMessageId(alert) ? eventLogRepository.saveAndFlush(logEntry) : eventLogRepository.save(logEntry);
        } catch (DataIntegrityViolationException duplicateMessageId) {
            if (hasMessageId(alert)) {
                log.info("Suppressing concurrently persisted {} alert with messageId={}", alert.type(), alert.messageId());
                rollbackDeduplication(deduplication);
                return;
            }
            rollbackDeduplication(deduplication);
            throw duplicateMessageId;
        } catch (RuntimeException e) {
            rollbackDeduplication(deduplication);
            throw e;
        }
        log.info("Persisted {} event log for robot: {}", alert.type(), alert.robotId());

        // 이벤트 클립 연결을 위해 로봇에 생성된 eventId 를 회신한다(블랙박스 파이프라인). (S15P11E101-588)
        notifyRobotEventSaved(savedEvent);

        // 서버 측 사건 클립 — HLS 세그먼트에서 잘라낸다(EventClipService).
        // 🔴 위 EVENT_SAVED 회신과 **경로가 다르다.** 로봇 파이프라인은 h264 세그먼트를 입력으로
        //    쓰는데 MJPEG 패스스루(2026-08-11) 이후 그 입력이 끊겨 있어 로봇은 올리지 못한다.
        //    둘은 배타적이지 않다 — 로봇이 다시 올릴 수 있게 되면 같은 eventId 에 클립이 둘
        //    붙고 관제는 목록으로 보여 준다(GET /api/events/{eventId}/video).
        // 리스너는 예약만 하고 즉시 반환한다. 사건 **이후** 구간의 세그먼트가 아직 없으므로
        // 실제 절단은 몇 초 뒤에 일어난다.
        eventPublisher.publishEvent(new EventClipRequestedEvent(
                this, savedEvent.getEventId(), savedEvent.getRobotId(),
                savedEvent.getType(), savedEvent.getTimestamp()));

        // 저장이 끝난 동일 이벤트의 식별자를 STOMP에 실어 즉시 상세 조회할 수 있게 한다.
        alertBroadcastService.broadcast(alert.withEventId(savedEvent.getEventId()));
        notificationDispatchService.enqueue(savedEvent, simulationRecipientUserId);
    }

    /**
     * 지금 활성화된 지도의 id. 좌표가 어느 지도의 것인지 남기기 위한 값이다.
     *
     * <p>여기서 실패해도 경보 저장은 계속돼야 한다 — 지도를 못 읽었다고 화재를
     * 잃는 것이 훨씬 나쁘다. 실패하면 null 이고, 관제는 소속 지도를 모르는 핑으로
     * 취급해 지도에 그리지 않는다(이벤트 이력에는 그대로 남는다).
     */
    private String currentMapId() {
        try {
            return mapService.activeMapId();
        } catch (RuntimeException e) {
            log.warn("활성 맵 조회 실패 — 이벤트에 mapId 없이 저장한다", e);
            return null;
        }
    }

    private DeduplicationAttempt acquireDeduplication(AlertMessage alert) {
        // message_id가 있는 새 로봇은 DB unique 제약이 재시작·다중 인스턴스까지 보장한다.
        if (hasMessageId(alert)) {
            return DeduplicationAttempt.notApplied();
        }
        if (!"ROBOT".equals(alert.source()) || alert.robotId() == null || alert.robotId().isBlank()) {
            return DeduplicationAttempt.notApplied();
        }

        String key = alert.robotId().trim() + ":" + alert.type();
        Instant receivedAt = Instant.now();
        AtomicBoolean duplicate = new AtomicBoolean(false);
        recentRobotAlerts.compute(key, (ignored, previousReceivedAt) -> {
            if (previousReceivedAt != null
                    && previousReceivedAt.plus(ALERT_DEDUP_WINDOW).isAfter(receivedAt)) {
                duplicate.set(true);
                return previousReceivedAt;
            }
            return receivedAt;
        });
        return new DeduplicationAttempt(key, receivedAt, duplicate.get());
    }

    private void rollbackDeduplication(DeduplicationAttempt attempt) {
        if (!attempt.duplicate() && attempt.key() != null) {
            recentRobotAlerts.remove(attempt.key(), attempt.receivedAt());
        }
    }

    private boolean hasMessageId(AlertMessage alert) {
        return alert.messageId() != null && !alert.messageId().isBlank();
    }

    private String normalizeMessageId(AlertMessage alert) {
        return hasMessageId(alert) ? alert.messageId().trim() : null;
    }

    private record DeduplicationAttempt(String key, Instant receivedAt, boolean duplicate) {
        private static DeduplicationAttempt notApplied() {
            return new DeduplicationAttempt(null, null, false);
        }
    }

    /**
     * 만료된 dedup 엔트리를 주기적으로 제거한다. 제거 로직이 없으면 임의 robot_id 로
     * 경보를 주입하는 공격/오동작 시 맵이 무한히 자라는 메모리 릭이 된다. (S15P11E101-715)
     */
    @Scheduled(fixedDelay = 300_000)  // 5분마다 실행 (ALERT_DEDUP_WINDOW가 10분이므로)
    void sweepExpiredDeduplicationEntries() {
        Instant cutoff = Instant.now().minus(ALERT_DEDUP_WINDOW);
        recentRobotAlerts.entrySet().removeIf(entry -> entry.getValue().isBefore(cutoff));
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
