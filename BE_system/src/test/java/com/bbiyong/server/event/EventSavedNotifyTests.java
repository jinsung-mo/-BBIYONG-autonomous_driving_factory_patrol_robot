package com.bbiyong.server.event;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.AlertMessage;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.event.service.EventLogService;
import com.bbiyong.server.event.service.AlertBroadcastService;
import com.bbiyong.server.notification.service.NotificationDispatchService;
import com.bbiyong.server.video.repository.VideoClipRepository;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotFireEvent;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 이벤트 저장 직후 로봇에 EVENT_SAVED(eventId) 를 회신하는지 검증. (S15P11E101-588)
 */
class EventSavedNotifyTests {

    private final EventLogRepository eventLogRepository = mock(EventLogRepository.class);
    private final NotificationDispatchService notificationDispatchService = mock(NotificationDispatchService.class);
    private final VideoClipRepository videoClipRepository = mock(VideoClipRepository.class);
    private final RobotWebSocketSessionManager sessionManager = mock(RobotWebSocketSessionManager.class);
    private final AlertBroadcastService alertBroadcastService = mock(AlertBroadcastService.class);

    private final EventLogService service = new EventLogService(
            eventLogRepository, notificationDispatchService, videoClipRepository, sessionManager, alertBroadcastService);

    private RobotPacket firePacket(String robotId) {
        RobotPacket p = new RobotPacket();
        p.setRobotId(robotId);
        p.setType("EVENT_FIRE");
        p.setConfidence(0.95);
        p.setTemperature(65.0);
        RobotPacket.Location loc = new RobotPacket.Location();
        loc.setX(10.0);
        loc.setY(20.0);
        loc.setYaw(0.0);
        p.setLocation(loc);
        return p;
    }

    @Test
    void sendsEventSavedWithGeneratedEventIdOnFire() {
        when(eventLogRepository.save(any(EventLog.class))).thenAnswer(inv -> {
            EventLog e = inv.getArgument(0);
            e.setEventId(1234L); // DB 저장 시 부여되는 PK 를 흉내
            return e;
        });

        service.handleFireEvent(new RobotFireEvent(this, firePacket("orinka_01")));

        ArgumentCaptor<Object> payloadCaptor = ArgumentCaptor.forClass(Object.class);
        verify(sessionManager).sendCommand(eq("orinka_01"), payloadCaptor.capture());

        @SuppressWarnings("unchecked")
        Map<String, Object> payload = (Map<String, Object>) payloadCaptor.getValue();
        assertThat(payload)
                .containsEntry("command", "EVENT_SAVED")
                .containsEntry("eventId", 1234L)
                .containsEntry("type", "FIRE");

        ArgumentCaptor<AlertMessage> alertCaptor = ArgumentCaptor.forClass(AlertMessage.class);
        verify(alertBroadcastService).broadcast(alertCaptor.capture());
        assertThat(alertCaptor.getValue().eventId()).isEqualTo(1234L);
    }

    @Test
    void doesNotSendWhenRobotIdMissing() {
        when(eventLogRepository.save(any(EventLog.class))).thenAnswer(inv -> {
            EventLog e = inv.getArgument(0);
            e.setEventId(1L);
            return e;
        });

        service.handleFireEvent(new RobotFireEvent(this, firePacket(null)));

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void suppressesDuplicateRobotFireWithinOneMinuteForAllAlertDestinations() {
        when(eventLogRepository.save(any(EventLog.class))).thenAnswer(inv -> {
            EventLog e = inv.getArgument(0);
            e.setEventId(1234L);
            return e;
        });

        service.handleFireEvent(new RobotFireEvent(this, firePacket("orinka_01")));
        service.handleFireEvent(new RobotFireEvent(this, firePacket("orinka_01")));

        verify(eventLogRepository, times(1)).save(any(EventLog.class));
        verify(sessionManager, times(1)).sendCommand(eq("orinka_01"), any());
        verify(alertBroadcastService, times(1)).broadcast(any());
        verify(notificationDispatchService, times(1)).enqueue(any(EventLog.class), eq(null));
    }
}
