package com.bbiyong.server.wss;

import com.bbiyong.server.wss.event.RobotDisconnectedEvent;
import org.junit.jupiter.api.RepeatedTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isA;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 실제 스레드로 메모리 세션 레지스트리를 검증한다. 네트워크 WebSocket 통합 테스트는 아니다. */
@Timeout(10)
class RobotWebSocketSessionManagerTests {

    private final RobotWebSocketSessionManager manager = new RobotWebSocketSessionManager(new ObjectMapper());

    private WebSocketSession session(String id) throws IOException {
        return session(id, false);
    }

    private WebSocketSession session(String id, boolean closeCallback) throws IOException {
        WebSocketSession session = mock(WebSocketSession.class);
        AtomicBoolean open = new AtomicBoolean(true);
        when(session.getId()).thenReturn(id);
        when(session.isOpen()).thenAnswer(invocation -> open.get());
        doAnswer(invocation -> {
            open.set(false);
            if (closeCallback) {
                assertThat(manager.unregisterBySessionId(id)).isNull();
            }
            return null;
        }).when(session).close();
        return session;
    }

    private static void await(CountDownLatch latch) throws InterruptedException {
        assertThat(latch.await(3, TimeUnit.SECONDS)).isTrue();
    }

    @Test
    void registeringSameSessionDoesNotPublishAnotherOnlineOrCloseIt() throws Exception {
        WebSocketSession current = session("current");
        assertThat(manager.register("robot", current)).isTrue();
        assertThat(manager.register("robot", current)).isFalse();
        assertThat(manager.getRobotIdBySessionId("current")).isEqualTo("robot");
        assertThat(manager.getConnectedRobotIds()).containsExactly("robot");
        verify(current, never()).close();
    }

    @Test
    void staleAndDuplicateCloseCallbacksCannotRemoveReplacement() throws Exception {
        WebSocketSession old = session("old");
        WebSocketSession replacement = session("replacement");
        manager.register("robot", old);
        manager.register("robot", replacement);

        assertThat(manager.unregisterBySessionId("old")).isNull();
        assertThat(manager.unregisterBySessionId("old")).isNull();
        assertThat(manager.getRobotIdBySessionId("old")).isNull();
        assertThat(manager.getRobotIdBySessionId("replacement")).isEqualTo("robot");
        assertThat(manager.sendCommand("robot", Map.of("command", "STOP"))).isTrue();
        verify(replacement).sendMessage(any());
        verify(old, never()).sendMessage(any());
    }

    @Test
    void synchronousCloseCallbackSeesReplacementAndReturnsNoOfflineRobot() throws Exception {
        WebSocketSession old = session("old");
        WebSocketSession replacement = session("replacement");
        AtomicReference<String> disconnected = new AtomicReference<>("not called");
        doAnswer(invocation -> {
            disconnected.set(manager.unregisterBySessionId("old"));
            assertThat(manager.getRobotIdBySessionId("replacement")).isEqualTo("robot");
            return null;
        }).when(old).close();
        manager.register("robot", old);

        assertThat(manager.register("robot", replacement)).isTrue();
        assertThat(disconnected.get()).isNull();
        assertThat(manager.isConnected("robot")).isTrue();
    }

    @Test
    void currentSessionRemovalReturnsRobotExactlyOnce() throws Exception {
        manager.register("robot", session("current"));
        assertThat(manager.unregisterBySessionId("current")).isEqualTo("robot");
        assertThat(manager.unregisterBySessionId("current")).isNull();
        assertThat(manager.unregisterBySessionId(null)).isNull();
        assertThat(manager.getRobotIdBySessionId("current")).isNull();
        assertThat(manager.isConnected("robot")).isFalse();
    }

    @Test
    void failedOldSessionCloseDoesNotRollbackReplacement() throws Exception {
        WebSocketSession old = session("old");
        doThrow(new IOException("close failed")).when(old).close();
        manager.register("robot", old);
        assertThat(manager.register("robot", session("replacement"))).isTrue();
        assertThat(manager.unregisterBySessionId("old")).isNull();
        assertThat(manager.getRobotIdBySessionId("replacement")).isEqualTo("robot");
        assertThat(manager.isConnected("robot")).isTrue();
    }

    @Test
    void sameSessionCannotBeReboundToAnotherRobot() throws Exception {
        WebSocketSession current = session("current");
        manager.register("first", current);
        assertThat(manager.register("second", current)).isFalse();
        assertThat(manager.getConnectedRobotIds()).containsExactly("first");
        assertThat(manager.getRobotIdBySessionId("current")).isEqualTo("first");
    }

    @RepeatedTest(25)
    void concurrentReconnectsKeepExactlyOneMatchingForwardAndReverseOwner() throws Exception {
        int count = 16;
        ExecutorService executor = Executors.newFixedThreadPool(count);
        CountDownLatch ready = new CountDownLatch(count);
        CountDownLatch start = new CountDownLatch(1);
        List<WebSocketSession> sessions = new ArrayList<>();
        List<Future<Boolean>> futures = new ArrayList<>();
        try {
            for (int i = 0; i < count; i++) {
                // 재접속이 이전 연결을 닫는 동안 실제 종료 콜백도 같은 스레드에서 실행한다.
                WebSocketSession next = session("session-" + i, true);
                sessions.add(next);
                futures.add(executor.submit(() -> {
                    ready.countDown();
                    await(start);
                    return manager.register("robot", next);
                }));
            }
            await(ready);
            start.countDown();
            for (Future<Boolean> future : futures) {
                assertThat(future.get(3, TimeUnit.SECONDS)).isTrue();
            }
            List<WebSocketSession> active = sessions.stream()
                    .filter(s -> manager.getRobotIdBySessionId(s.getId()) != null).toList();
            assertThat(active).hasSize(1);
            assertThat(manager.getConnectedRobotIds()).containsExactly("robot");
            for (WebSocketSession candidate : sessions) {
                if (candidate != active.get(0)) {
                    assertThat(manager.unregisterBySessionId(candidate.getId())).isNull();
                }
            }
            assertThat(manager.sendCommand("robot", Map.of("command", "STOP"))).isTrue();
            verify(active.get(0)).sendMessage(any());
            assertThat(manager.unregisterBySessionId(active.get(0).getId())).isEqualTo("robot");
            assertThat(manager.getConnectedRobotIds()).isEmpty();
        } finally {
            start.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void alreadyEnteredCloseAndReconnectCannotSplitTheTwoMaps() throws Exception {
        WebSocketSession old = session("old");
        WebSocketSession replacement = session("replacement");
        manager.register("robot", old);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch removalInsideLock = new CountDownLatch(1);
        CountDownLatch continueRemoval = new CountDownLatch(1);
        CountDownLatch registrationStarted = new CountDownLatch(1);
        AtomicReference<Thread> closingThread = new AtomicReference<>();
        when(old.getId()).thenAnswer(invocation -> {
            if (Thread.currentThread() == closingThread.get()) {
                removalInsideLock.countDown();
                await(continueRemoval);
            }
            return "old";
        });
        try {
            Future<String> removed = executor.submit(() -> {
                closingThread.set(Thread.currentThread());
                return manager.unregisterBySessionId("old");
            });
            await(removalInsideLock);
            Future<Boolean> registered = executor.submit(() -> {
                registrationStarted.countDown();
                return manager.register("robot", replacement);
            });
            await(registrationStarted);
            continueRemoval.countDown();
            assertThat(removed.get(3, TimeUnit.SECONDS)).isEqualTo("robot");
            assertThat(registered.get(3, TimeUnit.SECONDS)).isTrue();
            assertThat(manager.getRobotIdBySessionId("old")).isNull();
            assertThat(manager.getRobotIdBySessionId("replacement")).isEqualTo("robot");
            assertThat(manager.unregisterBySessionId("old")).isNull();
            assertThat(manager.isConnected("robot")).isTrue();
        } finally {
            continueRemoval.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void blockingCloseIoDoesNotHoldRegistryLock() throws Exception {
        WebSocketSession old = session("old");
        manager.register("robot", old);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        CountDownLatch closeStarted = new CountDownLatch(1);
        CountDownLatch finishClose = new CountDownLatch(1);
        doAnswer(invocation -> {
            closeStarted.countDown();
            await(finishClose);
            return null;
        }).when(old).close();
        try {
            Future<Boolean> replacement = executor.submit(() -> manager.register("robot", session("replacement")));
            await(closeStarted);
            Future<Boolean> unrelated = executor.submit(() -> {
                assertThat(manager.getRobotIdBySessionId("replacement")).isEqualTo("robot");
                assertThat(manager.unregisterBySessionId("old")).isNull();
                return manager.register("other-robot", session("other"));
            });
            assertThat(unrelated.get(2, TimeUnit.SECONDS)).isTrue();
            finishClose.countDown();
            assertThat(replacement.get(3, TimeUnit.SECONDS)).isTrue();
        } finally {
            finishClose.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    void closeAllClearsBothMapsBeforeExternalCloseCallback() throws Exception {
        WebSocketSession old = session("old");
        WebSocketSession replacement = session("replacement");
        manager.register("robot", old);
        doAnswer(invocation -> {
            assertThat(manager.getConnectedRobotIds()).isEmpty();
            assertThat(manager.register("robot", replacement)).isTrue();
            assertThat(manager.unregisterBySessionId("old")).isNull();
            return null;
        }).when(old).close();
        manager.closeAll();
        assertThat(manager.getRobotIdBySessionId("old")).isNull();
        assertThat(manager.getRobotIdBySessionId("replacement")).isEqualTo("robot");
        assertThat(manager.isConnected("robot")).isTrue();
    }

    @Test
    void handlerDoesNotPublishOfflineForStaleCallbackAndPublishesCurrentOnlyOnce() throws Exception {
        ApplicationEventPublisher publisher = mock(ApplicationEventPublisher.class);
        RobotWebSocketHandler handler = new RobotWebSocketHandler(manager, new ObjectMapper(), publisher);
        WebSocketSession old = session("old");
        WebSocketSession replacement = session("replacement");
        manager.register("robot", old);
        manager.register("robot", replacement);
        handler.afterConnectionClosed(old, CloseStatus.NORMAL);
        verify(publisher, never()).publishEvent(isA(RobotDisconnectedEvent.class));
        handler.afterConnectionClosed(replacement, CloseStatus.NORMAL);
        handler.afterConnectionClosed(replacement, CloseStatus.NORMAL);
        verify(publisher, times(1)).publishEvent(isA(RobotDisconnectedEvent.class));
    }
}
