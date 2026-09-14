package com.bbiyong.server.map.controller;

import com.bbiyong.server.map.dto.MapGridResponse;
import com.bbiyong.server.map.dto.MapResponses;
import com.bbiyong.server.map.dto.MapUploadRequest;
import com.bbiyong.server.map.dto.MappingStatusResponse;
import com.bbiyong.server.map.service.MapGridService;
import com.bbiyong.server.map.service.MapService;
import com.bbiyong.server.map.service.MappingStatusService;
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

    private static final String DEFAULT_ROBOT_ID = "orinka_01";

    private final MapService mapService;
    private final MapGridService mapGridService;
    private final MappingStatusService mappingStatusService;

    public MapController(MapService mapService, MapGridService mapGridService,
                         MappingStatusService mappingStatusService) {
        this.mapService = mapService;
        this.mapGridService = mapGridService;
        this.mappingStatusService = mappingStatusService;
    }

    /**
     * 온디맨드 매핑 진행 상태 조회. 새로고침·중간접속 클라이언트가 "지도" 탭 상태(매핑중 vs 도면)를
     * 복원하는 데 사용한다. 실시간 전환은 STOMP {@code /topic/mapping} 의 {@code MAPPING_STATUS} 구독. (S15P11E101-737 후속)
     */
    @GetMapping("/status")
    public ResponseEntity<MappingStatusResponse> mappingStatus(
            @RequestParam(required = false) String robotId) {
        String id = (robotId != null && !robotId.isBlank()) ? robotId : DEFAULT_ROBOT_ID;
        return ResponseEntity.ok(mappingStatusService.snapshot(id));
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

    /** 현재 활성 맵 조회. ('/{id}' 보다 먼저 선언해 리터럴 경로 우선 매칭.) */
    @GetMapping("/active")
    public ResponseEntity<MapResponses.Detail> active() {
        return ResponseEntity.ok(mapService.getActive());
    }

    /** 활성 맵의 3D 압출용 벽 격자. ('/{id}/grid' 보다 먼저 선언해 리터럴 경로 우선 매칭.) (S15P11E101-728) */
    @GetMapping("/active/grid")
    public ResponseEntity<MapGridResponse> activeGrid(
            @RequestParam(required = false) Integer maxCells,
            @RequestParam(required = false) Integer threshold) {
        return ResponseEntity.ok(mapGridService.getActiveGrid(maxCells, threshold));
    }

    /** 지정 맵의 3D 압출용 벽 격자(다운샘플 이진 격자 + 좌표 메타). (S15P11E101-728) */
    @GetMapping("/{id}/grid")
    public ResponseEntity<MapGridResponse> grid(
            @PathVariable String id,
            @RequestParam(required = false) Integer maxCells,
            @RequestParam(required = false) Integer threshold) {
        return ResponseEntity.ok(mapGridService.getGrid(id, maxCells, threshold));
    }

    /** 저장된 맵을 활성 맵으로 지정(온디맨드 매핑 완료 후 '이 맵 사용'). */
    @PutMapping("/{id}/active")
    public ResponseEntity<MapResponses.Detail> setActive(@PathVariable String id) {
        return ResponseEntity.ok(mapService.setActive(id));
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
