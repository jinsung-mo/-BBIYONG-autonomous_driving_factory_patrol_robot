package com.bbiyong.server.event.controller;

import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.service.EventLogService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
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
}
