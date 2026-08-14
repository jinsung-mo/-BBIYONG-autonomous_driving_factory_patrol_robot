package com.bbiyong.server.waypoint.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;

import java.util.List;

/**
 * 순찰 경로 일괄 설정 요청. 경로 = 순서 있는 지점(waypoint)들. (S15P11E101-520)
 */
public record RouteRequest(
        @NotNull @Valid List<WaypointRequest> waypoints
) {
}
