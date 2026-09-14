package com.bbiyong.server.event.dto;

import lombok.Data;

import java.time.LocalDate;

/**
 * 이벤트 필터링 파라미터
 */
@Data
public class EventFilterRequest {
    /**
     * 이벤트 타입 (FIRE, OVERHEAT, SYSTEM)
     */
    private String type;

    /**
     * 심각도 (CRITICAL, WARNING)
     */
    private String level;

    /**
     * 해결 상태 (UNRESOLVED, RESOLVED)
     */
    private String status;

    /**
     * 로봇 ID
     */
    private String robotId;

    /**
     * 설비 ID (OVERHEAT 전용)
     */
    private String equipmentId;

    /**
     * 시작 날짜 (해당 날짜 00:00:00 이후)
     */
    private LocalDate startDate;

    /**
     * 종료 날짜 (해당 날짜 23:59:59 이전)
     */
    private LocalDate endDate;
}
