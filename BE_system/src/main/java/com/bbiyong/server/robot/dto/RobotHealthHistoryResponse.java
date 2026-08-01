package com.bbiyong.server.robot.dto;

import com.bbiyong.server.robot.domain.RobotHealthHistory;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;
import java.util.stream.Collectors;

/**
 * 로봇 건강 이력 응답
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class RobotHealthHistoryResponse {

    private String robotId;
    private Instant startTime;
    private Instant endTime;
    private List<HealthDataPoint> dataPoints;

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class HealthDataPoint {
        private Instant timestamp;
        private Double battery;
        private Double speed;
        private Integer commLatencyMs;
        private Double inferenceFps;
        private String status;
        private String estop;
        private Boolean online;

        public static HealthDataPoint from(RobotHealthHistory history) {
            return HealthDataPoint.builder()
                    .timestamp(history.getTimestamp())
                    .battery(history.getBattery())
                    .speed(history.getSpeed())
                    .commLatencyMs(history.getCommLatencyMs())
                    .inferenceFps(history.getInferenceFps())
                    .status(history.getStatus())
                    .estop(history.getEstop())
                    .online(history.getOnline())
                    .build();
        }
    }

    public static RobotHealthHistoryResponse from(String robotId, Instant startTime, Instant endTime, List<RobotHealthHistory> histories) {
        return RobotHealthHistoryResponse.builder()
                .robotId(robotId)
                .startTime(startTime)
                .endTime(endTime)
                .dataPoints(histories.stream()
                        .map(HealthDataPoint::from)
                        .collect(Collectors.toList()))
                .build();
    }
}
