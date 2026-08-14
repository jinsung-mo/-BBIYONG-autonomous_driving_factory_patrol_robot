package com.bbiyong.server.event.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;

/**
 * 이벤트 통계 응답 (차트용)
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class EventStatsResponse {

    private String groupBy; // "hour", "day", "robot", "equipment", "type"
    private Instant startTime;
    private Instant endTime;
    private List<DataPoint> dataPoints;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class DataPoint {
        private String label; // 시간, 로봇ID, 설비ID, 이벤트 타입 등
        private Instant timestamp; // 시계열 데이터의 경우
        private Long totalCount; // 전체 이벤트 수
        private Long criticalCount; // CRITICAL 이벤트 수
        private Long warningCount; // WARNING 이벤트 수
        private Long unresolvedCount; // 미해결 이벤트 수
        private Long resolvedCount; // 해결된 이벤트 수
    }
}
