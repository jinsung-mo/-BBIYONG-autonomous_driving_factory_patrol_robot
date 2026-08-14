package com.bbiyong.server.equipment.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

/**
 * 분전반 과열 임계온도 설정 요청 (S15P11E101-836).
 *
 * 로봇 명령 프로토콜에 SET_THRESHOLD 가 없어 로봇으로 하달하지 않고, 서버가 이 값을 저장해
 * '최근온도 &gt; 임계온도' 면 과열(OVER)로 판정한다. 0 이하는 의미가 없어 @Positive 로 막는다.
 */
public record EquipmentThresholdRequest(
        @NotNull @Positive Double threshold
) {
}
