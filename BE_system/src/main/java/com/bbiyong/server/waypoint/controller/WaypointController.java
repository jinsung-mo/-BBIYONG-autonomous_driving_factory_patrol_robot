package com.bbiyong.server.waypoint.controller;

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

import java.util.List;

/**
 * 순찰 지점(waypoint) API. 관제 웹이 2D 지도 클릭으로 만든 순찰 경로를 CRUD 하고 로봇에 하달한다.
 */
@RestController
@RequestMapping("/api/waypoints")
public class WaypointController {

    private final WaypointService waypointService;

    public WaypointController(WaypointService waypointService) {
        this.waypointService = waypointService;
    }

    /** 지도 클릭 지점 1개 추가. */
    @PostMapping
    public ResponseEntity<WaypointResponses.Item> add(
            @RequestParam(required = false) String robotId,
            @Valid @RequestBody WaypointRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(waypointService.add(robotId, request));
    }

    /** 순찰 경로 조회(순서대로). */
    @GetMapping
    public ResponseEntity<List<WaypointResponses.Item>> list(
            @RequestParam(required = false) String robotId) {
        return ResponseEntity.ok(waypointService.list(robotId));
    }

    /** 순찰 경로 일괄 교체(FE의 "경로 저장"). */
    @PutMapping
    public ResponseEntity<List<WaypointResponses.Item>> replace(
            @RequestParam(required = false) String robotId,
            @RequestBody List<WaypointRequest> requests) {
        return ResponseEntity.ok(waypointService.replace(robotId, requests));
    }

    /** 순찰 지점 1개 삭제. */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
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
