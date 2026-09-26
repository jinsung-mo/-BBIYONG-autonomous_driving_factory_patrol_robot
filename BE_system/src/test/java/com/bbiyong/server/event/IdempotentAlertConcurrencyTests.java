package com.bbiyong.server.event;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotFireEvent;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.test.annotation.DirtiesContext;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 같은 멱등 키(messageId)를 가진 경보가 동시에 들어와도 DB에 한 건만 남는지 검증한다.
 *
 * <p>프로젝트 종료 후 개인 저장소에서 추가한 검증 테스트다(docs/post-project). 운영과 같은 MySQL에서
 * 실행해야 의미가 있다. SQLite 방언은 UNIQUE 제약을 무시하므로 이 테스트가 통과하지 않는다.
 */
@SpringBootTest(properties = {
        // 사건 클립 절단(ffmpeg)은 이 검증과 무관하므로 끈다.
        "bbiyong.video.clip-event-types=NONE"
})
@DirtiesContext
class IdempotentAlertConcurrencyTests {

    private static final int REQUESTS = 100;
    private static final int THREADS = 32;

    @Autowired
    private EventLogRepository eventLogRepository;

    @Autowired
    private ApplicationEventPublisher eventPublisher;

    /**
     * 서버가 여러 대이거나 저장 경로가 병렬일 때를 가정한다. 조회 없이 곧바로 INSERT를 100번 동시에
     * 시도하면, UNIQUE 제약이 1건만 통과시키고 나머지 99건은 제약 위반으로 막아야 한다.
     */
    @Test
    void concurrentInsertsWithSameMessageIdKeepExactlyOneRow() throws Exception {
        String messageId = "it-db-" + UUID.randomUUID();
        AtomicInteger saved = new AtomicInteger();
        AtomicInteger rejected = new AtomicInteger();
        CountDownLatch startGate = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(THREADS);

        List<Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < REQUESTS; i++) {
            futures.add(pool.submit(() -> {
                startGate.await();
                try {
                    eventLogRepository.saveAndFlush(fireLog(messageId));
                    saved.incrementAndGet();
                } catch (DataIntegrityViolationException duplicate) {
                    rejected.incrementAndGet();
                }
                return null;
            }));
        }

        long started = System.nanoTime();
        startGate.countDown();
        for (Future<?> f : futures) {
            f.get(30, TimeUnit.SECONDS);
        }
        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        pool.shutdown();

        System.out.printf("[idempotency/db] requests=%d threads=%d saved=%d rejected=%d elapsedMs=%d%n",
                REQUESTS, THREADS, saved.get(), rejected.get(), elapsedMs);

        assertThat(saved.get()).isEqualTo(1);
        assertThat(rejected.get()).isEqualTo(REQUESTS - 1);
        assertThat(countByMessageId(messageId)).isEqualTo(1);
    }

    /**
     * 실제 수신 경로와 같은 방식으로, 같은 화재 경보(RobotFireEvent)를 100개 스레드에서 동시에 발행한다.
     * 경보 저장 리스너(@Async 단일 스레드)가 모두 처리한 뒤에도 이벤트 이력은 한 건이어야 한다.
     */
    @Test
    void publishingSameFireAlertConcurrentlyPersistsOnce() throws Exception {
        String messageId = "it-event-" + UUID.randomUUID();
        CountDownLatch startGate = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(THREADS);

        List<Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < REQUESTS; i++) {
            futures.add(pool.submit(() -> {
                startGate.await();
                eventPublisher.publishEvent(new RobotFireEvent(this, firePacket(messageId)));
                return null;
            }));
        }

        long started = System.nanoTime();
        startGate.countDown();
        for (Future<?> f : futures) {
            f.get(30, TimeUnit.SECONDS);
        }
        pool.shutdown();

        // 비동기 저장이 끝날 때까지 기다린다. 한 건이 저장된 뒤 추가로 늘어나지 않는지도 잠시 더 지켜본다.
        long deadline = System.currentTimeMillis() + 15_000;
        while (countByMessageId(messageId) == 0 && System.currentTimeMillis() < deadline) {
            Thread.sleep(50);
        }
        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        Thread.sleep(1_000);

        System.out.printf("[idempotency/event] published=%d threads=%d persisted=%d firstPersistMs=%d%n",
                REQUESTS, THREADS, countByMessageId(messageId), elapsedMs);

        assertThat(countByMessageId(messageId)).isEqualTo(1);
    }

    private long countByMessageId(String messageId) {
        return eventLogRepository.findByMessageId(messageId).isPresent() ? 1 : 0;
    }

    private EventLog fireLog(String messageId) {
        EventLog log = new EventLog();
        log.setType("FIRE");
        log.setLevel("CRITICAL");
        log.setRobotId("orinka_it");
        log.setMessageId(messageId);
        log.setMessage("동시성 검증용 화재 경보");
        log.setTimestamp(Instant.now());
        log.setStatus("UNRESOLVED");
        return log;
    }

    private RobotPacket firePacket(String messageId) {
        RobotPacket p = new RobotPacket();
        p.setSource("robot");
        p.setType("EVENT_FIRE");
        p.setRobotId("orinka_it_" + messageId.substring(messageId.length() - 6));
        p.setMessageId(messageId);
        p.setConfidence(0.95);
        p.setTemperature(65.0);
        RobotPacket.Location loc = new RobotPacket.Location();
        loc.setX(1.0);
        loc.setY(2.0);
        loc.setYaw(0.0);
        p.setLocation(loc);
        return p;
    }
}
