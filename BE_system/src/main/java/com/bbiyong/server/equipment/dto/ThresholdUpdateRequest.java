package com.bbiyong.server.equipment.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

/**
 * 설비 임계 온도 수정 요청.
 * 임계 판정 자체는 로봇이 보유하며, 서버 값은 표시용 참고값이다.
 */
public record ThresholdUpdateRequest(
        @NotNull(message = "threshold 는 필수입니다.")
        @Positive(message = "threshold 는 0보다 커야 합니다.")
        Double threshold
) {
}
