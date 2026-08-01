package com.bbiyong.server.scheduler.dto;

import com.bbiyong.server.scheduler.domain.PatrolSchedule;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * 순찰 스케줄 응답
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PatrolScheduleResponse {

    private Long scheduleId;
    private String name;
    private String robotId;
    private String cronExpression;
    private Boolean enabled;
    private Instant lastExecuted;
    private Instant createdAt;
    private Instant updatedAt;

    public static PatrolScheduleResponse from(PatrolSchedule schedule) {
        return PatrolScheduleResponse.builder()
                .scheduleId(schedule.getScheduleId())
                .name(schedule.getName())
                .robotId(schedule.getRobotId())
                .cronExpression(schedule.getCronExpression())
                .enabled(schedule.getEnabled())
                .lastExecuted(schedule.getLastExecuted())
                .createdAt(schedule.getCreatedAt())
                .updatedAt(schedule.getUpdatedAt())
                .build();
    }
}
