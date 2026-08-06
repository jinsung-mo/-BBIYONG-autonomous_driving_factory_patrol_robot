package com.bbiyong.server.zone.controller;

import com.bbiyong.server.zone.dto.ZoneDtos.ResolveResponse;
import com.bbiyong.server.zone.dto.ZoneDtos.ZoneRequest;
import com.bbiyong.server.zone.dto.ZoneDtos.ZoneResponse;
import com.bbiyong.server.zone.service.ZoneService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 구역(Zone) 라벨 API — 좌표를 사람이 읽는 위치로 변환한다. (S15P11E101-769)
 * 조회·resolve 는 전체 사용자, 쓰기(생성/수정/삭제/시드)는 ADMIN 전용.
 */
@Tag(name = "Zone", description = "구역 정의 및 좌표→구역명 변환 API")
@RestController
@RequestMapping("/api/zones")
public class ZoneController {

    private final ZoneService zoneService;

    public ZoneController(ZoneService zoneService) {
        this.zoneService = zoneService;
    }

    @Operation(summary = "구역 목록", security = @SecurityRequirement(name = "bearerAuth"))
    @GetMapping
    public ResponseEntity<List<ZoneResponse>> list() {
        return ResponseEntity.ok(ZoneResponse.list(zoneService.list()));
    }

    @Operation(summary = "구역 생성 (ADMIN)", security = @SecurityRequirement(name = "bearerAuth"))
    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping
    public ResponseEntity<ZoneResponse> create(@Valid @RequestBody ZoneRequest req) {
        return ResponseEntity.status(HttpStatus.CREATED).body(ZoneResponse.of(zoneService.create(req)));
    }

    @Operation(summary = "구역 수정 (ADMIN)", security = @SecurityRequirement(name = "bearerAuth"))
    @PreAuthorize("hasRole('ADMIN')")
    @PutMapping("/{id}")
    public ResponseEntity<ZoneResponse> update(@PathVariable String id, @Valid @RequestBody ZoneRequest req) {
        return ResponseEntity.ok(ZoneResponse.of(zoneService.update(id, req)));
    }

    @Operation(summary = "구역 삭제 (ADMIN)", security = @SecurityRequirement(name = "bearerAuth"))
    @PreAuthorize("hasRole('ADMIN')")
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        zoneService.delete(id);
        return ResponseEntity.noContent().build();
    }

    @Operation(summary = "활성 맵 기준 격자 구역 시드 (ADMIN)",
            description = "활성 맵 경계를 rows x cols 격자로 나눠 '구역 A1' 형식으로 생성합니다. "
                    + "기존 구역이 있으면 replace=true 일 때만 대체합니다.",
            security = @SecurityRequirement(name = "bearerAuth"))
    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/seed-grid")
    public ResponseEntity<List<ZoneResponse>> seedGrid(
            @RequestParam(defaultValue = "3") int rows,
            @RequestParam(defaultValue = "3") int cols,
            @RequestParam(defaultValue = "false") boolean replace) {
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(ZoneResponse.list(zoneService.seedGrid(rows, cols, replace)));
    }

    @Operation(summary = "좌표 → 위치 라벨 변환",
            description = "구역명 우선, 최근접 설비/웨이포인트 보조('분전반 A 근처(1.2m)'), 근거가 없으면 좌표 폴백.",
            security = @SecurityRequirement(name = "bearerAuth"))
    @GetMapping("/resolve")
    public ResponseEntity<ResolveResponse> resolve(@RequestParam double x, @RequestParam double y) {
        return ResponseEntity.ok(zoneService.resolve(x, y));
    }
}
