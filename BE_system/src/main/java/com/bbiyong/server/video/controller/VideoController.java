package com.bbiyong.server.video.controller;

import com.bbiyong.server.video.dto.VideoRegisterRequest;
import com.bbiyong.server.video.dto.VideoResponses;
import com.bbiyong.server.video.service.VideoService;
import jakarta.validation.Valid;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;

@RestController
@RequestMapping("/api")
public class VideoController {

    private final VideoService videoService;

    public VideoController(VideoService videoService) {
        this.videoService = videoService;
    }

    /** 녹화 주체(로봇/게이트웨이)가 업로드 완료 후 메타데이터 등록. */
    @PostMapping("/videos")
    public ResponseEntity<VideoResponses.RegisterResult> register(@Valid @RequestBody VideoRegisterRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(videoService.register(request));
    }

    @GetMapping("/videos")
    public ResponseEntity<VideoResponses.PageResult> list(
            @RequestParam(required = false) String robotId,
            @RequestParam(required = false) String clipType,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant to,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "10") int size) {
        return ResponseEntity.ok(videoService.list(robotId, clipType, from, to, page, size));
    }

    @GetMapping("/videos/{id}")
    public ResponseEntity<VideoResponses.Detail> detail(@PathVariable String id) {
        return ResponseEntity.ok(videoService.getDetail(id));
    }

    /** 특정 이벤트에 연관된 영상 클립 목록. */
    @GetMapping("/events/{eventId}/video")
    public ResponseEntity<List<VideoResponses.Summary>> byEvent(@PathVariable Long eventId) {
        return ResponseEntity.ok(videoService.getByEvent(eventId));
    }
}
