package com.bbiyong.server.event.dto;

import com.bbiyong.server.event.domain.EventLog;
import org.springframework.data.domain.Page;

import java.util.List;

/**
 * 이벤트 이력 페이징 조회 응답.
 */
public record EventPageResponse(
        List<EventLog> content,
        int page,
        int size,
        int totalPages,
        long totalElements
) {
    public static EventPageResponse from(Page<EventLog> page) {
        return new EventPageResponse(
                page.getContent(),
                page.getNumber(),
                page.getSize(),
                page.getTotalPages(),
                page.getTotalElements()
        );
    }
}
