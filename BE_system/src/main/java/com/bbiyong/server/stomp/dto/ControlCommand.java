package com.bbiyong.server.stomp.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

/**
 * 웹 대시보드가 STOMP /app/control/* 로 보내는 제어 명령 페이로드.
 * 백엔드가 검증 후 로봇 WSS 명령 계약(remote_control_protocol)으로 변환·중계한다.
 */
@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class ControlCommand {

    @JsonProperty("robot_id")
    private String robotId;

    private String command; // DRIVE | SET_MODE | ESTOP | NAVIGATE | SAVE_MAP | START_MAPPING

    // DRIVE
    private Double linear;
    private Double angular;

    // SET_MODE
    private String mode; // autonomy | manual | disabled

    // ESTOP (fail-safe: 활성화만 허용)
    private Boolean active;

    // NAVIGATE
    private Double x;
    private Double y;
    private Double yaw;

    // SAVE_MAP
    private String name;
}
