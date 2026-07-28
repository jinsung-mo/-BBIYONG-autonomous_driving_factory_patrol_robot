package com.bbiyong.server.video.controller;

import com.bbiyong.server.video.dto.VideoRegisterRequest;
import com.bbiyong.server.video.dto.VideoResponses;
import com.bbiyong.server.video.dto.VideoUploadRequest;
import com.bbiyong.server.video.service.VideoService;
import jakarta.validation.Valid;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.ResourceRegion;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpRange;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.time.Instant;
import java.util.List;

@RestController
@RequestMapping("/api")
public class VideoController {

    /** Range 응답 1회당 최대 청크 크기(1MB). 브라우저가 후속 Range 를 이어서 요청한다. */
    private static final long MAX_CHUNK_BYTES = 1024 * 1024;

    private final VideoService videoService;

    public VideoController(VideoService videoService) {
        this.videoService = videoService;
    }

    /** 녹화 주체(로봇/게이트웨이)가 업로드 완료 후 메타데이터 등록(외부/S3 저장분). */
    @PostMapping("/videos")
    public ResponseEntity<VideoResponses.RegisterResult> register(@Valid @RequestBody VideoRegisterRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(videoService.register(request));
    }

    /** 영상 파일 바이트를 직접 업로드하여 서버 파일시스템에 저장 + 메타데이터 등록. */
    @PostMapping(value = "/videos/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<VideoResponses.RegisterResult> upload(
            @RequestPart("file") MultipartFile file,
            @RequestPart(value = "thumbnail", required = false) MultipartFile thumbnail,
            @RequestParam String robotId,
            @RequestParam(required = false) Long eventId,
            @RequestParam(defaultValue = "PATROL") String clipType,
            @RequestParam(required = false) Integer durationSec,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant startedAt,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) Instant endedAt) {
        VideoUploadRequest meta = new VideoUploadRequest(robotId, eventId, clipType, durationSec, startedAt, endedAt);
        return ResponseEntity.status(HttpStatus.CREATED).body(videoService.registerUpload(meta, file, thumbnail));
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

    /** 저장된 영상 재생 스트리밍. HTTP Range 요청 시 206 Partial Content 로 응답. */
    @GetMapping("/videos/{id}/stream")
    public ResponseEntity<ResourceRegion> stream(@PathVariable String id, @RequestHeader HttpHeaders headers) {
        VideoService.StoredFile stored = videoService.loadVideo(id);
        Resource resource = stored.resource();
        MediaType mediaType = MediaType.parseMediaType(stored.contentType());
        long length = contentLength(resource);

        List<HttpRange> ranges = headers.getRange();
        if (ranges.isEmpty()) {
            // Range 미지정: 전체 파일을 단일 region 으로 200 응답.
            ResourceRegion full = new ResourceRegion(resource, 0, length);
            return ResponseEntity.ok()
                    .contentType(mediaType)
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                    .body(full);
        }

        HttpRange range = ranges.get(0);
        long start = range.getRangeStart(length);
        long end = range.getRangeEnd(length);
        long chunk = Math.min(MAX_CHUNK_BYTES, end - start + 1);
        ResourceRegion region = new ResourceRegion(resource, start, chunk);
        return ResponseEntity.status(HttpStatus.PARTIAL_CONTENT)
                .contentType(mediaType)
                .header(HttpHeaders.ACCEPT_RANGES, "bytes")
                .body(region);
    }

    /** 저장된 썸네일 이미지 서빙. */
    @GetMapping("/videos/{id}/thumbnail")
    public ResponseEntity<Resource> thumbnail(@PathVariable String id) {
        VideoService.StoredFile stored = videoService.loadThumbnail(id);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(stored.contentType()))
                .body(stored.resource());
    }

    /** 특정 이벤트에 연관된 영상 클립 목록. */
    @GetMapping("/events/{eventId}/video")
    public ResponseEntity<List<VideoResponses.Summary>> byEvent(@PathVariable Long eventId) {
        return ResponseEntity.ok(videoService.getByEvent(eventId));
    }

    private static long contentLength(Resource resource) {
        try {
            return resource.contentLength();
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "파일 길이를 읽을 수 없습니다.", e);
        }
    }
}
