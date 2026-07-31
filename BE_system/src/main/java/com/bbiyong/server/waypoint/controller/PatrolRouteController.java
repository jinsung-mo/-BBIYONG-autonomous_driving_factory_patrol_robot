package com.bbiyong.server.waypoint.controller;

import com.bbiyong.server.waypoint.dto.RouteRequest;
import com.bbiyong.server.waypoint.dto.WaypointRequest;
import com.bbiyong.server.waypoint.dto.WaypointResponses;
import com.bbiyong.server.waypoint.service.WaypointService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 순찰 경로(patrol route) 중심 API. (S15P11E101-520)
 *
 * <p>순찰 경로 = 순서 있는 순찰 지점(waypoint)들의 집합. 한 화면(순찰 경로 설정)에서
 * 경로 조회/일괄 저장과 개별 지점 추가/삭제·로봇 하달까지 다룬다.
 * 데이터는 {@link WaypointService}(=/api/waypoints 와 동일 소스)를 재사용한다.
 */
@RestController
@RequestMapping("/api/patrol-route")
public class PatrolRouteController {

    private final WaypointService waypointService;

    public PatrolRouteController(WaypointService waypointService) {
        this.waypointService = waypointService;
    }

    /** 순찰 경로 전체 조회(순서대로). */
    @GetMapping
    public ResponseEntity<WaypointResponses.Route> getRoute(
            @RequestParam(required = false) String robotId) {
        return ResponseEntity.ok(waypointService.getRoute(robotId));
    }

    /** 순찰 경로 일괄 저장(교체). */
    @PutMapping
    public ResponseEntity<WaypointResponses.Route> replaceRoute(
            @RequestParam(required = false) String robotId,
            @Valid @RequestBody RouteRequest request) {
        waypointService.replace(robotId, request.waypoints());
        return ResponseEntity.ok(waypointService.getRoute(robotId));
    }

    /** 경로에 순찰 지점 1개 추가(지도 클릭). */
    @PostMapping("/points")
    public ResponseEntity<WaypointResponses.Item> addPoint(
            @RequestParam(required = false) String robotId,
            @Valid @RequestBody WaypointRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(waypointService.add(robotId, request));
    }

    /** 경로에서 순찰 지점 1개 삭제. */
    @DeleteMapping("/points/{id}")
    public ResponseEntity<Void> deletePoint(@PathVariable String id) {
        waypointService.delete(id);
        return ResponseEntity.noContent().build();
    }

    /** 저장된 순찰 경로를 로봇에 하달(SET_PATROL_ROUTE). */
    @PostMapping("/apply")
    public ResponseEntity<WaypointResponses.ApplyResult> apply(
            @RequestParam(required = false) String robotId) {
        return ResponseEntity.ok(waypointService.apply(robotId));
    }
}
