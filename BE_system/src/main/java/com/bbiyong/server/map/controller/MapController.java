package com.bbiyong.server.map.controller;

import com.bbiyong.server.map.dto.MapResponses;
import com.bbiyong.server.map.dto.MapUploadRequest;
import com.bbiyong.server.map.service.MapService;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;

@RestController
@RequestMapping("/api/maps")
public class MapController {

    private final MapService mapService;

    public MapController(MapService mapService) {
        this.mapService = mapService;
    }

    /** SLAM 맵 이미지 업로드(로봇/게이트웨이가 SAVE_MAP 산출물 등록). */
    @PostMapping(value = "/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<MapResponses.RegisterResult> upload(
            @RequestPart("file") MultipartFile file,
            @RequestParam(required = false) String robotId,
            @RequestParam(defaultValue = "map") String name,
            @RequestParam(required = false) Integer widthPx,
            @RequestParam(required = false) Integer heightPx,
            @RequestParam(required = false) Double resolution,
            @RequestParam(required = false) Double originX,
            @RequestParam(required = false) Double originY,
            @RequestParam(required = false) Double originYaw) {
        MapUploadRequest meta = new MapUploadRequest(robotId, name, widthPx, heightPx, resolution, originX, originY, originYaw);
        return ResponseEntity.status(HttpStatus.CREATED).body(mapService.register(meta, file));
    }

    @GetMapping
    public ResponseEntity<List<MapResponses.Summary>> list() {
        return ResponseEntity.ok(mapService.list());
    }

    /** 로봇별 최신 맵(대시보드가 현재 도면을 그릴 때 사용). */
    @GetMapping("/latest")
    public ResponseEntity<MapResponses.Detail> latest(@RequestParam(required = false) String robotId) {
        return ResponseEntity.ok(mapService.getLatest(robotId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<MapResponses.Detail> detail(@PathVariable String id) {
        return ResponseEntity.ok(mapService.getDetail(id));
    }

    /** 저장된 맵 이미지 서빙. */
    @GetMapping("/{id}/image")
    public ResponseEntity<Resource> image(@PathVariable String id) {
        MapService.StoredFile stored = mapService.loadImage(id);
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType(stored.contentType()))
                .body(stored.resource());
    }
}
