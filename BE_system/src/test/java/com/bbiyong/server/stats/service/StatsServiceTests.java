package com.bbiyong.server.stats.service;

import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.robot.domain.RobotHealthHistory;
import com.bbiyong.server.robot.repository.RobotHealthHistoryRepository;
import com.bbiyong.server.stats.dto.StatsResponses;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 통계 집계: 설비별 과열 랭킹(시뮬 제외·정렬), 주간 추이(0 채움), 배터리 추정(방전/충전/표본부족) 검증.
 */
class StatsServiceTests {

    private final EventLogRepository eventRepository = mock(EventLogRepository.class);
    private final EquipmentRepository equipmentRepository = mock(EquipmentRepository.class);
    private final RobotHealthHistoryRepository healthRepository = mock(RobotHealthHistoryRepository.class);
    private final StatsService service = new StatsService(eventRepository, equipmentRepository, healthRepository);

    private static EventLog event(String type, String equipmentId, Instant at, boolean simulated) {
        EventLog e = new EventLog();
        e.setType(type);
        e.setEquipmentId(equipmentId);
        e.setTimestamp(at);
        e.setSimulated(simulated);
        e.setLevel("WARNING");
        return e;
    }

    private static RobotHealthHistory health(Instant at, double battery) {
        RobotHealthHistory h = new RobotHealthHistory();
        h.setTimestamp(at);
        h.setBattery(battery);
        h.setRobotId("orinka_01");
        return h;
    }

    @Test
    void overheatRankingGroupsSortsAndExcludesSimulated() {
        Instant now = Instant.now();
        when(eventRepository.findByTimestampAfter(any())).thenReturn(List.of(
                event("OVERHEAT", "panel_A", now.minusSeconds(300), false),
                event("OVERHEAT", "panel_A", now.minusSeconds(200), false),
                event("OVERHEAT", "panel_B", now.minusSeconds(100), false),
                event("OVERHEAT", "panel_C", now.minusSeconds(50), true),   // 시연용 — 제외
                event("FIRE", "panel_A", now.minusSeconds(10), false)));      // 화재 — 과열 아님
        Equipment a = new Equipment();
        a.setEquipmentId("panel_A");
        a.setName("분전반 A");
        when(equipmentRepository.findAll()).thenReturn(List.of(a));

        StatsResponses.OverheatEquipment result = service.overheatByEquipment(7, false);

        assertThat(result.totalCount()).isEqualTo(3);
        assertThat(result.items()).hasSize(2);
        assertThat(result.items().get(0).equipmentId()).isEqualTo("panel_A");
        assertThat(result.items().get(0).name()).isEqualTo("분전반 A");
        assertThat(result.items().get(0).count()).isEqualTo(2);
        assertThat(result.items().get(1).name()).isEqualTo("panel_B"); // 미등록 설비는 ID 폴백
    }

    @Test
    void alertsWeeklyFillsEmptyDaysWithZero() {
        // 자정 직후 실행돼도 "오늘" 버킷에 안전하게 들어가도록 오늘 정오(KST) 고정
        Instant todayNoon = java.time.LocalDate.now(StatsService.ZONE)
                .atTime(12, 0).atZone(StatsService.ZONE).toInstant();
        when(eventRepository.findByTimestampAfter(any())).thenReturn(List.of(
                event("FIRE", null, todayNoon, false),
                event("OVERHEAT", "panel_A", todayNoon, false)));

        StatsResponses.AlertsWeekly result = service.alertsWeekly(7, false);

        assertThat(result.items()).hasSize(7);
        // 오늘(마지막 버킷)에 화재 1·과열 1, 나머지 날은 0
        StatsResponses.AlertsDay today = result.items().get(6);
        assertThat(today.fire()).isEqualTo(1);
        assertThat(today.overheat()).isEqualTo(1);
        assertThat(today.total()).isEqualTo(2);
        assertThat(result.items().get(0).total()).isZero();
    }

    @Test
    void batteryEstimateComputesRemainingMinutesWhenDischarging() {
        Instant base = Instant.now().minus(Duration.ofMinutes(60));
        // 60분 동안 80% → 68% (12%/h 방전)
        when(healthRepository.findRecentByRobotId(eq("orinka_01"), anyInt())).thenReturn(List.of(
                health(base, 80.0),
                health(base.plus(Duration.ofMinutes(15)), 77.0),
                health(base.plus(Duration.ofMinutes(30)), 74.0),
                health(base.plus(Duration.ofMinutes(45)), 71.0),
                health(base.plus(Duration.ofMinutes(60)), 68.0)));

        StatsResponses.BatteryEstimate result = service.batteryEstimate("orinka_01", 60);

        assertThat(result.battery()).isEqualTo(68.0);
        assertThat(result.dischargePerHour()).isEqualTo(12.0);
        // 68% / 12%/h = 5.67h = 340분
        assertThat(result.estimatedRemainingMinutes()).isEqualTo(340);
        assertThat(result.basisMinutes()).isEqualTo(60);
    }

    @Test
    void batteryEstimateIsNullWhileCharging() {
        Instant base = Instant.now().minus(Duration.ofMinutes(60));
        when(healthRepository.findRecentByRobotId(eq("orinka_01"), anyInt())).thenReturn(List.of(
                health(base, 40.0),
                health(base.plus(Duration.ofMinutes(15)), 45.0),
                health(base.plus(Duration.ofMinutes(30)), 50.0),
                health(base.plus(Duration.ofMinutes(45)), 55.0),
                health(base.plus(Duration.ofMinutes(60)), 60.0)));

        StatsResponses.BatteryEstimate result = service.batteryEstimate("orinka_01", 60);

        assertThat(result.battery()).isEqualTo(60.0);
        assertThat(result.dischargePerHour()).isNull();
        assertThat(result.estimatedRemainingMinutes()).isNull();
    }

    @Test
    void batteryEstimateIsNullWithInsufficientData() {
        when(healthRepository.findRecentByRobotId(eq("orinka_01"), anyInt())).thenReturn(List.of(
                health(Instant.now(), 55.0)));

        StatsResponses.BatteryEstimate result = service.batteryEstimate("orinka_01", 60);

        assertThat(result.battery()).isEqualTo(55.0);
        assertThat(result.estimatedRemainingMinutes()).isNull();
    }
}
