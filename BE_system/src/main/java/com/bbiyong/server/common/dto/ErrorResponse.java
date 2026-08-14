package com.bbiyong.server.common.dto;

/**
 * 명세 1.0 공통 에러 응답 포맷.
 */
public record ErrorResponse(
        String timestamp,
        int status,
        String error,
        String message,
        String path
) {
}
