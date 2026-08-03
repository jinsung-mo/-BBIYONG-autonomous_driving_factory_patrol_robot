package com.bbiyong.server.event.controller;

import com.bbiyong.server.wss.event.SimulatedRobotFireEvent;
import com.bbiyong.server.wss.event.SimulatedRobotOverheatEvent;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.ApplicationEvent;
import org.springframework.web.server.ResponseStatusException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class EventSimulationControllerTests {
    private final ApplicationEventPublisher publisher = mock(ApplicationEventPublisher.class);
    private final EventSimulationController controller = new EventSimulationController(publisher, true);

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
}
