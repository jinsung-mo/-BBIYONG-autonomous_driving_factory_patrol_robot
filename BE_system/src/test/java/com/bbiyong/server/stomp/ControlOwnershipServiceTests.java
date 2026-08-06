package com.bbiyong.server.stomp;

import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.messaging.Message;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.support.GenericMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import tools.jackson.databind.ObjectMapper;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 조종 점유(lease) 상태기계 검증 — 획득 / 거부 / 갱신 / 만료 / 탈취 / 세션종료 해제.
 */
class ControlOwnershipServiceTests {

    private static final String ROBOT = "orinka_01";

    private final RobotWebSocketSessionManager sessionManager = mock(RobotWebSocketSessionManager.class);
    private final SimpMessagingTemplate messagingTemplate = mock(SimpMessagingTemplate.class);
    private final ControlOwnershipService service =
            new ControlOwnershipService(sessionManager, messagingTemplate, new ObjectMapper());

    @Test
    @DisplayName("비어 있는 로봇은 첫 요청자가 획득한다")
    void acquiresWhenFree() {
        assertThat(service.claim(ROBOT, "s1", "a@x.io", false))
                .isEqualTo(ControlOwnershipService.Decision.ACQUIRED);
        assertThat(service.isOwner(ROBOT, "s1")).isTrue();
        assertThat(service.current(ROBOT).getEmail()).isEqualTo("a@x.io");
    }

    @Test
    @DisplayName("소유자의 후속 명령은 리스를 갱신한다(브로드캐스트 없음)")
    void renewsForOwner() {
        service.claim(ROBOT, "s1", "a@x.io", false);
        assertThat(service.claim(ROBOT, "s1", "a@x.io", false))
                .isEqualTo(ControlOwnershipService.Decision.RENEWED);
    }

    @Test
    @DisplayName("타인이 점유 중이면 거부된다")
    void deniesOtherSession() {
        service.claim(ROBOT, "s1", "a@x.io", false);
        assertThat(service.claim(ROBOT, "s2", "b@x.io", false))
                .isEqualTo(ControlOwnershipService.Decision.DENIED);
        assertThat(service.isOwner(ROBOT, "s1")).isTrue();
    }

    @Test
    @DisplayName("리스 만료(2.0초) 후에는 다른 세션이 획득할 수 있다")
    void expiresAfterLeaseWindow() throws Exception {
        service.claim(ROBOT, "s1", "a@x.io", false);
        assertThat(ControlOwnershipService.LEASE_MILLIS).isEqualTo(2_000L);

        // 리스 창을 실제로 기다리는 대신 sweep 이 만료를 인식하는지 확인한다.
        Thread.sleep(ControlOwnershipService.LEASE_MILLIS + 100);

        assertThat(service.current(ROBOT)).isNull();
        assertThat(service.claim(ROBOT, "s2", "b@x.io", false))
                .isEqualTo(ControlOwnershipService.Decision.ACQUIRED);
    }

    @Test
    @DisplayName("만료된 리스는 sweep 이 제거하고 EXPIRED 를 방송한다")
    void sweepRemovesExpiredLease() throws Exception {
        service.claim(ROBOT, "s1", "a@x.io", false);
        Thread.sleep(ControlOwnershipService.LEASE_MILLIS + 100);

        service.sweep();

        assertThat(service.current(ROBOT)).isNull();
        assertThat(capturedBroadcasts()).contains("EXPIRED");
    }

    @Test
    @DisplayName("강제 탈취는 소유자를 바꾸고 DRIVE(0,0) 정지 프레임을 1회 발행한다")
    void takeoverForcesStopFrame() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        service.claim(ROBOT, "s1", "a@x.io", false);

        assertThat(service.claim(ROBOT, "s2", "b@x.io", true))
                .isEqualTo(ControlOwnershipService.Decision.TAKEN_OVER);
        assertThat(service.isOwner(ROBOT, "s2")).isTrue();

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(sessionManager).sendCommand(eq(ROBOT), captor.capture());
        assertThat(captor.getValue()).containsEntry("command", "DRIVE")
                .containsEntry("linear", 0.0)
                .containsEntry("angular", 0.0);
    }

    @Test
    @DisplayName("탈취당한 이전 소유자에게도 개인 큐로 사유가 통지된다")
    void takeoverNotifiesPreviousOwner() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        service.claim(ROBOT, "s1", "a@x.io", false);

        service.claim(ROBOT, "s2", "b@x.io", true);

        ArgumentCaptor<Object> captor = ArgumentCaptor.forClass(Object.class);
        verify(messagingTemplate).convertAndSendToUser(eq("a@x.io"), eq("/queue/control"), captor.capture());
        assertThat(String.valueOf(captor.getValue())).contains("\"reason\":\"TAKEN_OVER_BY_OTHER\"");
    }

    @Test
    @DisplayName("소유자가 아닌 세션의 반납 요청은 무시된다")
    void releaseIgnoredForNonOwner() {
        service.claim(ROBOT, "s1", "a@x.io", false);
        assertThat(service.release(ROBOT, "s2")).isFalse();
        assertThat(service.isOwner(ROBOT, "s1")).isTrue();
    }

    @Test
    @DisplayName("소유자의 반납은 즉시 점유를 해제한다")
    void releaseByOwner() {
        service.claim(ROBOT, "s1", "a@x.io", false);
        assertThat(service.release(ROBOT, "s1")).isTrue();
        assertThat(service.current(ROBOT)).isNull();
    }

    @Test
    @DisplayName("STOMP 세션 종료 시 점유가 즉시 해제되고 정지 프레임이 나간다")
    void sessionDisconnectReleasesLease() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        service.claim(ROBOT, "s1", "a@x.io", false);

        service.onSessionDisconnect(disconnectEvent("s1"));

        assertThat(service.current(ROBOT)).isNull();
        verify(sessionManager).sendCommand(eq(ROBOT), any());
        assertThat(capturedBroadcasts()).contains("DISCONNECTED");
    }

    @Test
    @DisplayName("다른 세션의 종료는 내 점유에 영향을 주지 않는다")
    void unrelatedDisconnectKeepsLease() {
        service.claim(ROBOT, "s1", "a@x.io", false);

        service.onSessionDisconnect(disconnectEvent("s9"));

        assertThat(service.isOwner(ROBOT, "s1")).isTrue();
        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    @DisplayName("브로드캐스트 계약: owner·ownerEmail·leftMs·serverTime 을 /topic/control/{robotId} 로 보낸다")
    void broadcastContract() {
        service.claim(ROBOT, "s1", "a@x.io", false);

        ArgumentCaptor<Object> captor = ArgumentCaptor.forClass(Object.class);
        verify(messagingTemplate, atLeastOnce())
                .convertAndSend(eq("/topic/control/" + ROBOT), captor.capture());
        String json = String.valueOf(captor.getValue());
        assertThat(json).contains("\"robotId\":\"" + ROBOT + "\"")
                .contains("\"event\":\"ACQUIRED\"")
                .contains("\"owner\":\"s1\"")
                .contains("\"ownerEmail\":\"a@x.io\"")
                .contains("\"leftMs\":")
                .contains("\"serverTime\":");
    }

    @Test
    @DisplayName("점유가 없으면 owner 는 null, leftMs 는 0 이다")
    void broadcastWhenFree() {
        service.broadcast(ROBOT, "STATUS");

        ArgumentCaptor<Object> captor = ArgumentCaptor.forClass(Object.class);
        verify(messagingTemplate).convertAndSend(eq("/topic/control/" + ROBOT), captor.capture());
        String json = String.valueOf(captor.getValue());
        assertThat(json).contains("\"owner\":null")
                .contains("\"ownerEmail\":null")
                .contains("\"leftMs\":0");
    }

    @Test
    @DisplayName("거부 사유는 요청자 개인 큐(/user/queue/control)로만 간다")
    void deniedNoticeGoesToUserQueue() {
        service.notifyDenied("b@x.io", ROBOT, "OWNED_BY_OTHER");

        ArgumentCaptor<Object> captor = ArgumentCaptor.forClass(Object.class);
        verify(messagingTemplate).convertAndSendToUser(eq("b@x.io"), eq("/queue/control"), captor.capture());
        String json = String.valueOf(captor.getValue());
        assertThat(json).contains("\"type\":\"CONTROL_DENIED\"")
                .contains("\"reason\":\"OWNED_BY_OTHER\"");
    }

    /** 전송된 모든 /topic/control 브로드캐스트 본문을 하나로 이어 붙인다. */
    private String capturedBroadcasts() {
        ArgumentCaptor<Object> captor = ArgumentCaptor.forClass(Object.class);
        verify(messagingTemplate, atLeastOnce())
                .convertAndSend(eq("/topic/control/" + ROBOT), captor.capture());
        return String.join("|", captor.getAllValues().stream().map(String::valueOf).toList());
    }

    private SessionDisconnectEvent disconnectEvent(String sessionId) {
        Message<byte[]> message = new GenericMessage<>(new byte[0]);
        return new SessionDisconnectEvent(this, message, sessionId, CloseStatus.NORMAL);
    }
}
