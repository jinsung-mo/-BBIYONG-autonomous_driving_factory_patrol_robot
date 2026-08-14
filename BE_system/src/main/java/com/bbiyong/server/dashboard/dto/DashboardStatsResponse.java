package com.bbiyong.server.dashboard.dto;

import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.robot.dto.RobotResponse;
import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * 관제센터 대시보드 통계 응답 DTO
 */
@Data
@Builder
public class DashboardStatsResponse {

    /**
     * 로봇 상태 요약
     */
    private RobotSummary summary;

    /**
     * 오늘 이벤트 통계
     */
    private TodayStats today;

    /**
     * 설비(분전반) 요약 통계
     */
    private EquipmentSummary equipment;

    /**
     * 설비 현재 상태 목록
     */
    private List<Equipment> equipmentStatus;

    /**
     * 최근 이벤트 (최대 5건)
     */
    private List<EventLog> recentEvents;

    /**
     * 로봇 현재 상태 목록
     */
    private List<RobotResponse> robotStatus;

    @Data
    @Builder
    public static class RobotSummary {
        /**
         * 전체 로봇 수
         */
        private int totalRobots;

        /**
         * 활동 중인 로봇 수 (순찰, 수동 제어)
         */
        private int activeRobots;

        /**
         * 충전 중인 로봇 수
         */
        private int chargingRobots;

        /**
         * 평균 배터리 잔량 (%)
         */
        private double avgBattery;

        /**
         * 연결된 로봇 수
         */
        private int onlineRobots;
    }

    @Data
    @Builder
    public static class TodayStats {
        /**
         * 오늘 총 이벤트 수
         */
        private long eventCount;

        /**
         * 치명적 이벤트 수 (CRITICAL - 화재)
         */
        private long criticalEvents;

        /**
         * 경고 이벤트 수 (WARNING - 과열)
         */
        private long warningEvents;

        /**
         * 해결된 이벤트 수
         */
        private long resolvedEvents;

        /**
         * 미해결 이벤트 수
         */
        private long unresolvedEvents;
    }

    @Data
    @Builder
    public static class EquipmentSummary {
        /**
         * 전체 설비 수
         */
        private int totalEquipments;

        /**
         * 과열 상태 설비 수 (status = OVER)
         */
        private int overheatingEquipments;

        /**
         * 정상 설비 수 (status = NORMAL)
         */
        private int normalEquipments;

        /**
         * 점검 이력 없는 설비 수 (status = UNKNOWN)
         */
        private int unknownEquipments;
    }
}
