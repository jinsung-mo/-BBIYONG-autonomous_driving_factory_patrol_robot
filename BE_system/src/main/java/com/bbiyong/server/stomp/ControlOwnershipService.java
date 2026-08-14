package com.bbiyong.server.stomp;

import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.context.event.EventListener;
import tools.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 로봇 1대에 대한 <b>조종 점유(control ownership)</b>를 관리한다.
 *
 * <p>배경: 제어 컨트롤러는 지금까지 무상태 fire-and-forget 중계였다. 두 명이 동시에 조종하면
 * 두 사람의 DRIVE 가 번갈아 로봇에 도달해 지터가 생기고, 서버는 누가 조종 중인지조차 몰랐다.
 *
 * <p>모델
 * <ul>
 *   <li><b>리스(lease) 2.0초</b> — FE 가 100ms 주기로 재전송하므로 짧은 리스(0.5초)는 지터에
 *       flapping 을 일으킨다. 로봇 로컬 리스(server.py CTL[drive_owner])와 같은 값이라 일관적이며,
 *       로봇 데드맨 0.4초가 별도로 동작하므로 안전은 리스와 무관하게 담보된다.</li>
 *   <li><b>암묵 획득</b> — 비어 있는(또는 만료된) 로봇에 제어 명령을 보내면 그 세션이 소유자가 된다.
 *       소유자의 후속 명령은 리스를 갱신한다. 명시적 획득({@code /app/control/ownership} ACQUIRE)도
 *       제공하며 FE 권장 흐름은 그쪽이다 — 암묵 획득은 아직 acquire 를 보내지 않는 현행 FE 가
 *       그대로 동작하도록 남긴 하위호환 경로다. 암묵 경로는 <b>비어 있는 리스만</b> 가져가므로
 *       (탈취는 명시적 TAKEOVER 로만 가능) 두 사용자가 번갈아 로봇을 흔드는 상황은 생기지 않는다.</li>
 *   <li><b>비소유자 명령은 드롭</b> — 로봇에 중계하지 않고, 요청자 개인 큐로 사유를 알린다.</li>
 *   <li><b>강제 탈취 허용</b> — stuck-key 등으로 리스가 영영 안 풀리는 시나리오가 실재하므로
 *       명시적 TAKEOVER 를 허용한다. 탈취 순간 {@code DRIVE(0,0)} 정지 프레임을 1회 강제 발행해
 *       이전 소유자의 마지막 명령이 로봇에 남아 있지 않게 한다.</li>
 *   <li><b>세션 종료 즉시 해제</b> — {@link SessionDisconnectEvent} 를 받아 바로 반납한다.</li>
 * </ul>
 *
 * <p>단일 컨테이너 + in-memory simple broker 구성이므로 {@link ConcurrentHashMap} 으로 충분하다.
 * (Redis·분산 락 불필요 — 도입 시 상태 저장소만 교체하면 된다.)
 */
@Slf4j
@Service
public class ControlOwnershipService {

    /** 리스 유효시간(ms). 로봇 로컬 리스와 동일. */
    public static final long LEASE_MILLIS = 2_000L;

    /** 점유 상태 브로드캐스트 목적지 접두사. FE 는 {@code /topic/control/{robotId}} 를 구독한다. */
    public static final String TOPIC_PREFIX = "/topic/control/";

    /** 거부 사유를 요청자 개인에게 알리는 목적지({@code /user/queue/control} 로 배달). */
    public static final String USER_QUEUE = "/queue/control";

    private final RobotWebSocketSessionManager sessionManager;
    private final SimpMessagingTemplate messagingTemplate;
    private final ObjectMapper objectMapper;

    /** robotId → 현재 리스. 만료된 항목은 조회·스윕 시점에 정리된다. */
    private final Map<String, Lease> leases = new ConcurrentHashMap<>();

    public ControlOwnershipService(RobotWebSocketSessionManager sessionManager,
                                   SimpMessagingTemplate messagingTemplate,
                                   ObjectMapper objectMapper) {
        this.sessionManager = sessionManager;
        this.messagingTemplate = messagingTemplate;
        this.objectMapper = objectMapper;
    }

    /** 점유 요청 결과. */
    public enum Decision {
        /** 비어 있던 점유를 새로 획득했다. */
        ACQUIRED,
        /** 이미 내 것이라 리스를 갱신했다. */
        RENEWED,
        /** 타인의 유효한 리스를 강제로 빼앗았다. */
        TAKEN_OVER,
        /** 타인이 점유 중이라 거부했다. */
        DENIED
    }

    /** 한 로봇의 점유 상태 스냅샷. */
    @Getter
    public static final class Lease {
        private final String sessionId;
        private final String email;
        private final long expiresAt;

        Lease(String sessionId, String email, long expiresAt) {
            this.sessionId = sessionId;
            this.email = email;
            this.expiresAt = expiresAt;
        }

        boolean isExpired(long now) {
            return now >= expiresAt;
        }
    }

    /**
     * 제어 명령 1건에 대한 점유 판정. 비어 있으면 획득, 내 것이면 갱신, 남의 것이면 거부한다.
     *
     * @param takeover true 면 남의 유효 리스라도 빼앗는다(정지 프레임 1회 발행 포함)
     */
    public Decision claim(String robotId, String sessionId, String email, boolean takeover) {
        long now = System.currentTimeMillis();
        Lease previous = leases.get(robotId);
        boolean previousAlive = previous != null && !previous.isExpired(now);

        if (previousAlive && !sessionId.equals(previous.getSessionId()) && !takeover) {
            return Decision.DENIED;
        }

        Decision decision;
        if (previousAlive && sessionId.equals(previous.getSessionId())) {
            decision = Decision.RENEWED;
        } else if (previousAlive) {
            decision = Decision.TAKEN_OVER;
        } else {
            decision = Decision.ACQUIRED;
        }

        leases.put(robotId, new Lease(sessionId, email, now + LEASE_MILLIS));

        if (decision == Decision.TAKEN_OVER) {
            log.warn("조종 점유 강제 탈취: robot[{}] {} <- {} (이전 소유자 {})",
                    robotId, email, sessionId, previous.getEmail());
            forceStop(robotId);
            // 빼앗긴 쪽도 즉시 알아야 FE 조이스틱을 바로 잠글 수 있다.
            notifyDenied(previous.getEmail(), robotId, "TAKEN_OVER_BY_OTHER");
        } else if (decision == Decision.ACQUIRED) {
            log.info("조종 점유 획득: robot[{}] {} ({})", robotId, email, sessionId);
        }

        if (decision != Decision.RENEWED) {
            broadcast(robotId, decision.name());
        }
        return decision;
    }

    /** 소유자 본인의 명시적 반납. 소유자가 아니면 아무 일도 하지 않는다. */
    public boolean release(String robotId, String sessionId) {
        Lease current = leases.get(robotId);
        if (current == null || !current.getSessionId().equals(sessionId)) {
            return false;
        }
        leases.remove(robotId, current);
        log.info("조종 점유 반납: robot[{}] {}", robotId, current.getEmail());
        broadcast(robotId, "RELEASED");
        return true;
    }

    /** 현재 유효한 리스(만료됐으면 null). */
    public Lease current(String robotId) {
        Lease lease = leases.get(robotId);
        if (lease == null) {
            return null;
        }
        return lease.isExpired(System.currentTimeMillis()) ? null : lease;
    }

    /** 해당 세션이 소유자인지. */
    public boolean isOwner(String robotId, String sessionId) {
        Lease lease = current(robotId);
        return lease != null && lease.getSessionId().equals(sessionId);
    }

    /** 브라우저 STOMP 세션이 끊기면 그 세션이 들고 있던 점유를 즉시 해제한다. */
    @EventListener
    public void onSessionDisconnect(SessionDisconnectEvent event) {
        releaseAllForSession(event.getSessionId());
    }

    /** 특정 세션이 보유한 모든 로봇의 점유를 해제한다. */
    public void releaseAllForSession(String sessionId) {
        if (sessionId == null) {
            return;
        }
        leases.forEach((robotId, lease) -> {
            if (lease.getSessionId().equals(sessionId) && leases.remove(robotId, lease)) {
                log.info("세션 종료로 조종 점유 해제: robot[{}] {}", robotId, lease.getEmail());
                forceStop(robotId);
                broadcast(robotId, "DISCONNECTED");
            }
        });
    }

    /**
     * 만료 스윕 + 상태 하트비트.
     *
     * <p>500ms 주기로 돈다. 만료된 리스는 제거하고 EXPIRED 를 알리며, 살아 있는 리스는
     * FE 배너의 남은시간 카운트다운이 서버와 어긋나지 않도록 HEARTBEAT 를 계속 보낸다.
     */
    @Scheduled(fixedRate = 500L)
    public void sweep() {
        long now = System.currentTimeMillis();
        leases.forEach((robotId, lease) -> {
            if (lease.isExpired(now)) {
                if (leases.remove(robotId, lease)) {
                    log.debug("조종 점유 만료: robot[{}] {}", robotId, lease.getEmail());
                    broadcast(robotId, "EXPIRED");
                }
            } else {
                broadcast(robotId, "HEARTBEAT");
            }
        });
    }

    /**
     * {@code /topic/control/{robotId}} 로 점유 상태를 방송한다.
     *
     * <p>계약: {@code {robotId, event, owner, ownerEmail, leftMs, serverTime}}.
     * 점유가 없으면 {@code owner}·{@code ownerEmail} 은 null, {@code leftMs} 는 0 이다.
     * {@code owner} 는 STOMP sessionId 로, FE 는 자기 sessionId 와 비교해 "내가 조종 중"을 판별한다.
     */
    public void broadcast(String robotId, String event) {
        long now = System.currentTimeMillis();
        Lease lease = leases.get(robotId);
        boolean alive = lease != null && !lease.isExpired(now);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("robotId", robotId);
        payload.put("event", event);
        payload.put("owner", alive ? lease.getSessionId() : null);
        payload.put("ownerEmail", alive ? lease.getEmail() : null);
        payload.put("leftMs", alive ? Math.max(0L, lease.getExpiresAt() - now) : 0L);
        payload.put("serverTime", now);

        try {
            messagingTemplate.convertAndSend(TOPIC_PREFIX + robotId, objectMapper.writeValueAsString(payload));
        } catch (Exception e) {
            log.error("조종 점유 상태 브로드캐스트 실패: robot[{}]", robotId, e);
        }
    }

    /**
     * 거부 사유를 요청자 개인에게만 알린다({@code /user/queue/control}).
     *
     * @param reason FORBIDDEN_ROLE(권한 없음) | OWNED_BY_OTHER(타인 점유 중)
     *               | TAKEN_OVER_BY_OTHER(내 점유를 남이 빼앗음)
     */
    public void notifyDenied(String userName, String robotId, String reason) {
        if (userName == null) {
            return;
        }
        long now = System.currentTimeMillis();
        Lease lease = leases.get(robotId);
        boolean alive = lease != null && !lease.isExpired(now);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("type", "CONTROL_DENIED");
        payload.put("robotId", robotId);
        payload.put("reason", reason);
        payload.put("owner", alive ? lease.getSessionId() : null);
        payload.put("ownerEmail", alive ? lease.getEmail() : null);
        payload.put("leftMs", alive ? Math.max(0L, lease.getExpiresAt() - now) : 0L);
        payload.put("serverTime", now);

        try {
            messagingTemplate.convertAndSendToUser(userName, USER_QUEUE, objectMapper.writeValueAsString(payload));
        } catch (Exception e) {
            log.error("조종 거부 통지 실패: user[{}] robot[{}]", userName, robotId, e);
        }
    }

    /**
     * 탈취·강제해제 시점에 {@code DRIVE(0,0)} 을 1회 발행한다.
     * 이전 소유자의 마지막 조향 명령이 로봇 쪽에 남아 있는 채로 주인이 바뀌는 것을 막는다.
     */
    private void forceStop(String robotId) {
        Map<String, Object> stop = new LinkedHashMap<>();
        stop.put("command", "DRIVE");
        stop.put("linear", 0.0);
        stop.put("angular", 0.0);
        boolean delivered = sessionManager.sendCommand(robotId, stop);
        if (!delivered) {
            log.warn("점유 전환 정지 프레임 미전달(로봇 [{}] 오프라인)", robotId);
        }
    }
}
