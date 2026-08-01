package com.bbiyong.server.event.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * 경보(이벤트) 상태 전이 요청. 허용값: UNRESOLVED | RESOLVED.
 */
public record EventStatusUpdateRequest(
        @NotBlank String status
) {
}
