package com.bbiyong.server.event.controller;

import com.bbiyong.server.wss.event.SimulatedRobotFireEvent;
import com.bbiyong.server.wss.event.SimulatedRobotOverheatEvent;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.ApplicationEvent;
import org.springframework.web.server.ResponseStatusException;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class EventSimulationControllerTests {
    private final ApplicationEventPublisher publisher = mock(ApplicationEventPublisher.class);
    private final MutableClock clock = new MutableClock(Instant.parse("2026-08-03T00:00:00Z"));
    private final EventSimulationController controller = new EventSimulationController(publisher, true, clock);

    @Test
    void publishesFireSimulationForCallingAdminOnly() {
        controller.simulate("admin@bbiyong.io", "FIRE");
        org.mockito.ArgumentCaptor<ApplicationEvent> captor = org.mockito.ArgumentCaptor.forClass(ApplicationEvent.class);
        verify(publisher).publishEvent(captor.capture());
        SimulatedRobotFireEvent event = (SimulatedRobotFireEvent) captor.getValue();
        assertThat(event.getRecipientUserId()).isEqualTo("admin@bbiyong.io");
        assertThat(event.getPacket().getSource()).isEqualTo("SIMULATION");
    }

    @Test
    void publishesOverheatSimulation() {
        controller.simulate("admin@bbiyong.io", "OVERHEAT");
        org.mockito.ArgumentCaptor<ApplicationEvent> captor = org.mockito.ArgumentCaptor.forClass(ApplicationEvent.class);
        verify(publisher).publishEvent(captor.capture());
        assertThat(captor.getValue()).isInstanceOf(SimulatedRobotOverheatEvent.class);
    }

    @Test
    void rejectsUnknownSimulationType() {
        assertThatThrownBy(() -> controller.simulate("admin@bbiyong.io", "SYSTEM"))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void rejectsSameAdminAndEventTypeDuringCooldown() {
        controller.simulate("admin@bbiyong.io", "FIRE");

        assertThatThrownBy(() -> controller.simulate("admin@bbiyong.io", "FIRE"))
                .isInstanceOfSatisfying(ResponseStatusException.class,
                        e -> assertThat(e.getStatusCode()).isEqualTo(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS));
        verify(publisher).publishEvent(org.mockito.ArgumentMatchers.any(SimulatedRobotFireEvent.class));
    }

    @Test
    void acceptsSameEventAfterCooldown() {
        controller.simulate("admin@bbiyong.io", "FIRE");
        clock.advanceSeconds(5);

        controller.simulate("admin@bbiyong.io", "FIRE");

        verify(publisher, org.mockito.Mockito.times(2))
                .publishEvent(org.mockito.ArgumentMatchers.any(SimulatedRobotFireEvent.class));
    }

    private static class MutableClock extends Clock {
        private Instant now;

        private MutableClock(Instant now) { this.now = now; }
        void advanceSeconds(long seconds) { now = now.plusSeconds(seconds); }
        @Override public ZoneOffset getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(java.time.ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }
}
