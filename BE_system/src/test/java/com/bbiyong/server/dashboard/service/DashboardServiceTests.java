package com.bbiyong.server.dashboard.service;

import com.bbiyong.server.dashboard.dto.DashboardStatsResponse;
import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.robot.service.RobotService;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 대시보드 통계 서비스 검증 — 설비 요약 집계 중심. (S15P11E101-573)
 */
class DashboardServiceTests {

    private final RobotService robotService = mock(RobotService.class);
    private final EventLogRepository eventLogRepository = mock(EventLogRepository.class);
    private final EquipmentRepository equipmentRepository = mock(EquipmentRepository.class);
    private final DashboardService service =
            new DashboardService(robotService, eventLogRepository, equipmentRepository);

    private Equipment equipment(String id, String status) {
        Equipment e = new Equipment();
        e.setEquipmentId(id);
        e.setStatus(status);
        return e;
    }

    @Test
    void aggregatesEquipmentSummaryByStatus() {
        when(robotService.getAllRobots()).thenReturn(List.of());
        when(eventLogRepository.findByTimestampAfter(any(Instant.class))).thenReturn(List.of());
        when(eventLogRepository.findLatestEvents(any())).thenReturn(List.of());
        List<Equipment> equipments = List.of(
                equipment("panel_A", "OVER"),
                equipment("panel_B", "NORMAL"),
                equipment("panel_C", "NORMAL"),
                equipment("panel_D", "UNKNOWN"));
        when(equipmentRepository.findAll()).thenReturn(equipments);

        DashboardStatsResponse stats = service.getStats();

        DashboardStatsResponse.EquipmentSummary summary = stats.getEquipment();
        assertThat(summary.getTotalEquipments()).isEqualTo(4);
        assertThat(summary.getOverheatingEquipments()).isEqualTo(1);
        assertThat(summary.getNormalEquipments()).isEqualTo(2);
        assertThat(summary.getUnknownEquipments()).isEqualTo(1);
        // 설비 상태 목록도 함께 노출
        assertThat(stats.getEquipmentStatus()).hasSize(4);
    }

    @Test
    void handlesNoEquipmentsGracefully() {
        when(robotService.getAllRobots()).thenReturn(List.of());
        when(eventLogRepository.findByTimestampAfter(any(Instant.class))).thenReturn(List.of());
        when(eventLogRepository.findLatestEvents(any())).thenReturn(List.of());
        when(equipmentRepository.findAll()).thenReturn(List.of());

        DashboardStatsResponse stats = service.getStats();

        assertThat(stats.getEquipment().getTotalEquipments()).isZero();
        assertThat(stats.getEquipmentStatus()).isEmpty();
    }
}
