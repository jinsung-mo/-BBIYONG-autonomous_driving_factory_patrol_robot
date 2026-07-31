package com.bbiyong.server.waypoint.dto;

import jakarta.validation.constraints.NotNull;

/**
 * 순찰 지점 등록/교체 요청. x/y 는 미터/월드 좌표(FE가 픽셀→미터 변환한 값).
 */
public record WaypointRequest(
        @NotNull Double x,
        @NotNull Double y,
        Double yaw,
        String name,
        Integer seq
) {
}
