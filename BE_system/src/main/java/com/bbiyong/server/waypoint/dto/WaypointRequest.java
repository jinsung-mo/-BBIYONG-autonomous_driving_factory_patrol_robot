package com.bbiyong.server.waypoint.dto;

import jakarta.validation.constraints.NotNull;

/**
 * 순찰 지점 등록/교체 요청. x/y 는 미터/월드 좌표(FE가 픽셀→미터 변환한 값).
 * yaw 는 ROS 월드프레임 <b>radians</b>(선택; 미지정 시 0.0). 로봇 patrol node 가 quaternion 으로 변환한다.
 */
public record WaypointRequest(
        @NotNull Double x,
        @NotNull Double y,
        Double yaw,
        String name,
        Integer seq
) {
}
