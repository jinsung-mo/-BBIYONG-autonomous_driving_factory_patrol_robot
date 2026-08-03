package com.bbiyong.server.dashboard.service;

import com.bbiyong.server.dashboard.dto.DashboardStatsResponse;
import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.robot.dto.RobotResponse;
import com.bbiyong.server.robot.service.RobotService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;

/**
 * 관제센터 대시보드 통계 서비스
 */
@Slf4j
@Service
public class DashboardService {

    private final RobotService robotService;
    private final EventLogRepository eventLogRepository;
    private final EquipmentRepository equipmentRepository;

    public DashboardService(RobotService robotService,
                            EventLogRepository eventLogRepository,
                            EquipmentRepository equipmentRepository) {
        this.robotService = robotService;
        this.eventLogRepository = eventLogRepository;
        this.equipmentRepository = equipmentRepository;
    }

    /**
     * 대시보드 통합 통계 조회
     */
    public DashboardStatsResponse getStats() {
        // 1. 로봇 상태 조회
        List<RobotResponse> robots = robotService.getAllRobots();

        // 2. 로봇 요약 통계
        DashboardStatsResponse.RobotSummary summary = calculateRobotSummary(robots);

        // 3. 오늘 이벤트 통계
        DashboardStatsResponse.TodayStats todayStats = calculateTodayStats();

        // 4. 최근 이벤트 5건
        List<EventLog> recentEvents = eventLogRepository.findLatestEvents(PageRequest.of(0, 5));

        // 5. 설비(분전반) 현황
        List<Equipment> equipments = equipmentRepository.findAll();
        DashboardStatsResponse.EquipmentSummary equipmentSummary = calculateEquipmentSummary(equipments);

        return DashboardStatsResponse.builder()
                .summary(summary)
                .today(todayStats)
                .equipment(equipmentSummary)
                .equipmentStatus(equipments)
                .recentEvents(recentEvents)
                .robotStatus(robots)
                .build();
    }

    /**
     * 설비 요약 통계 계산. 과열 판단은 로봇이 통지한 status("OVER") 로 한다. (S15P11E101-573)
     */
    private DashboardStatsResponse.EquipmentSummary calculateEquipmentSummary(List<Equipment> equipments) {
        int total = equipments.size();
        int overheating = (int) equipments.stream().filter(e -> "OVER".equals(e.getStatus())).count();
        int normal = (int) equipments.stream().filter(e -> "NORMAL".equals(e.getStatus())).count();
        int unknown = (int) equipments.stream().filter(e -> "UNKNOWN".equals(e.getStatus())).count();

        return DashboardStatsResponse.EquipmentSummary.builder()
                .totalEquipments(total)
                .overheatingEquipments(overheating)
                .normalEquipments(normal)
                .unknownEquipments(unknown)
                .build();
    }

    /**
     * 로봇 요약 통계 계산
     */
    private DashboardStatsResponse.RobotSummary calculateRobotSummary(List<RobotResponse> robots) {
        int totalRobots = robots.size();
        int activeRobots = (int) robots.stream()
                .filter(r -> "AUTO_PATROL".equals(r.getStatus()) || "MANUAL_CONTROL".equals(r.getStatus()))
                .count();
        int chargingRobots = (int) robots.stream()
                .filter(r -> "CHARGING".equals(r.getStatus()))
                .count();
        int onlineRobots = (int) robots.stream()
                .filter(r -> r.getOnline() != null && r.getOnline())
                .count();

        double avgBattery = robots.stream()
                .mapToDouble(r -> r.getBattery() != null ? r.getBattery() : 0.0)
                .average()
                .orElse(0.0);

        return DashboardStatsResponse.RobotSummary.builder()
                .totalRobots(totalRobots)
                .activeRobots(activeRobots)
                .chargingRobots(chargingRobots)
                .avgBattery(Math.round(avgBattery * 10) / 10.0) // 소수점 1자리
                .onlineRobots(onlineRobots)
                .build();
    }

    /**
     * 오늘 이벤트 통계 계산
     */
    private DashboardStatsResponse.TodayStats calculateTodayStats() {
        // 오늘 00:00:00 (시스템 기본 타임존)
        Instant todayStart = LocalDate.now()
                .atStartOfDay(ZoneId.systemDefault())
                .toInstant();

        // 오늘 이벤트 전체
        List<EventLog> todayEvents = eventLogRepository.findByTimestampAfter(todayStart);

        long totalCount = todayEvents.size();
        long criticalCount = todayEvents.stream()
                .filter(e -> "CRITICAL".equals(e.getLevel()))
                .count();
        long warningCount = todayEvents.stream()
                .filter(e -> "WARNING".equals(e.getLevel()))
                .count();
        long resolvedCount = todayEvents.stream()
                .filter(e -> "RESOLVED".equals(e.getStatus()))
                .count();
        long unresolvedCount = todayEvents.stream()
                .filter(e -> "UNRESOLVED".equals(e.getStatus()))
                .count();

        return DashboardStatsResponse.TodayStats.builder()
                .eventCount(totalCount)
                .criticalEvents(criticalCount)
                .warningEvents(warningCount)
                .resolvedEvents(resolvedCount)
                .unresolvedEvents(unresolvedCount)
                .build();
    }
}
