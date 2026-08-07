package com.bbiyong.server.stomp.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

/**
 * 웹 대시보드가 STOMP /app/control/inspection 으로 보내는 AprilTag 점검 지점 명령. (S15P11E101-778)
 * 백엔드가 검증 후 로봇 계약(inspection_point_command)으로 변환·중계한다.
 */
@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class InspectionCommand {

    @JsonProperty("robot_id")
    private String robotId;

    /** CONFIRM | REJECT | UPDATE | DELETE | PUBLISH */
    private String command;

    /** CONFIRM/REJECT 대상 후보 ID */
    private String candidateId;

    /** UPDATE/DELETE 대상 확정 지점 ID */
    private String pointId;

    /** CONFIRM/UPDATE 시 지점 이름(선택, 최대 128자) */
    private String name;

    /** UPDATE 시 순찰 포함 여부(선택). FE 의 '순찰 제외' 토글이 이 필드로 온다. */
    private Boolean enabled;

    /** UPDATE 시 순찰 순서(선택). */
    private Integer sequence;
}
