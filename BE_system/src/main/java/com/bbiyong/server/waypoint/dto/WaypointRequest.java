package com.bbiyong.server.waypoint.dto;

import jakarta.validation.constraints.NotNull;

/**
 * 순찰 지점 등록/교체 요청. x/y 는 미터/월드 좌표(FE가 픽셀→미터 변환한 값).
 * yaw 는 ROS 월드프레임 <b>radians</b>(선택). 미지정(null) 시 로봇 patrol node 가 가장 가까운
 * 구조물을 바라보도록 자동 계산한다 — 0.0 으로 강제하지 않는다(2026-08-07). 지정 시 quaternion 으로 변환한다.
 */
public record WaypointRequest(
        @NotNull Double x,
        @NotNull Double y,
        Double yaw,
        String name,
        Integer seq
) {
}
