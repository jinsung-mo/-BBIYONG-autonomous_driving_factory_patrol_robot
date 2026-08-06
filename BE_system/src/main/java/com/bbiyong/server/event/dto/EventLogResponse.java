package com.bbiyong.server.event.dto;

import com.bbiyong.server.event.domain.EventLog;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * 이벤트 로그 응답 DTO
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class EventLogResponse {

    private Long eventId;
    private String type;
    private String level;
    private String robotId;
    private String messageId;
    private String equipmentId;
    private Double x;
    private Double y;
    private Double confidence;
    private Double temperature;
    private Double threshold;
    private String message;
    private Instant timestamp;
    private String status;
    private Boolean hasVideo; // 연관 영상 존재 여부

    public static EventLogResponse from(EventLog event, boolean hasVideo) {
        return EventLogResponse.builder()
                .eventId(event.getEventId())
                .type(event.getType())
                .level(event.getLevel())
                .robotId(event.getRobotId())
                .messageId(event.getMessageId())
                .equipmentId(event.getEquipmentId())
                .x(event.getX())
                .y(event.getY())
                .confidence(event.getConfidence())
                .temperature(event.getTemperature())
                .threshold(event.getThreshold())
                .message(event.getMessage())
                .timestamp(event.getTimestamp())
                .status(event.getStatus())
                .hasVideo(hasVideo)
                .build();
    }
}
