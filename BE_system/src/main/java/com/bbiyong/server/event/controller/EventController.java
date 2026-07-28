package com.bbiyong.server.event.controller;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.dto.EventStatusUpdateRequest;
import com.bbiyong.server.event.service.EventLogService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/events")
public class EventController {

    private final EventLogService eventLogService;

    public EventController(EventLogService eventLogService) {
        this.eventLogService = eventLogService;
    }

    @GetMapping
    public ResponseEntity<EventPageResponse> getEvents(
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "10") int size,
            @RequestParam(required = false) String type) {
        return ResponseEntity.ok(eventLogService.getEvents(page, size, type));
    }

    /** 경보(이벤트) 상태 전이 — 관제사가 처리완료(RESOLVED) 등으로 표시. */
    @PatchMapping("/{eventId}")
    public ResponseEntity<EventLog> updateStatus(
            @PathVariable Long eventId,
            @Valid @RequestBody EventStatusUpdateRequest request) {
        return ResponseEntity.ok(eventLogService.updateStatus(eventId, request.status()));
    }
}
