package com.bbiyong.server.event.dto;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.video.dto.VideoResponses;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.List;

/**
 * 이벤트 로그 상세 조회 응답 (연관 영상 정보 포함)
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class EventLogDetailResponse {

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
    private List<VideoResponses.Summary> videos; // 연관 영상 목록

    public static EventLogDetailResponse from(EventLog event, List<VideoResponses.Summary> videos) {
        return EventLogDetailResponse.builder()
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
                .videos(videos)
                .build();
    }
}
