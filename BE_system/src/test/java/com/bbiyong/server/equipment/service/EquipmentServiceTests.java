package com.bbiyong.server.equipment.service;

import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.server.ResponseStatusException;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 임계값 수정 시 DB 갱신과 함께 로봇으로 SET_THRESHOLD 명령이 중계되는지 검증.
 */
class EquipmentServiceTests {

    private final EquipmentRepository repository = mock(EquipmentRepository.class);
    private final RobotWebSocketSessionManager sessionManager = mock(RobotWebSocketSessionManager.class);
    private final EquipmentService service = new EquipmentService(repository, sessionManager);

    @Test
    @SuppressWarnings("unchecked")
    void updateThresholdRelaysSetThresholdToRobot() {
        Equipment equipment = new Equipment();
        equipment.setEquipmentId("panel_A");
        when(repository.findById("panel_A")).thenReturn(Optional.of(equipment));
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);

        service.updateThreshold("panel_A", 62.5);

        assertThat(equipment.getThreshold()).isEqualTo(62.5);
        verify(repository).save(equipment);

        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(sessionManager).sendCommand(eq("orinka_01"), captor.capture());
        assertThat(captor.getValue())
                .containsEntry("command", "SET_THRESHOLD")
                .containsEntry("equipmentId", "panel_A")
                .containsEntry("threshold", 62.5);
    }

    @Test
    void updateThresholdMissingEquipmentDoesNotRelay() {
        when(repository.findById("panel_ZZZ")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> service.updateThreshold("panel_ZZZ", 50.0))
                .isInstanceOf(ResponseStatusException.class);

        verify(sessionManager, never()).sendCommand(any(), any());
    }
}
