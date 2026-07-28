package com.bbiyong.server.equipment.dto;

/**
 * 명세 2.2 설비 수정 응답 포맷: {"status": "SUCCESS"}.
 */
public record StatusResponse(String status) {

    public static StatusResponse success() {
        return new StatusResponse("SUCCESS");
    }
}
