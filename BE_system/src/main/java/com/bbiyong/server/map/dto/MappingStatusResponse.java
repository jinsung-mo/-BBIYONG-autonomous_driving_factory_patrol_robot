package com.bbiyong.server.map.dto;

import java.time.Instant;

/**
 * 온디맨드 매핑 진행 상태 조회 응답. (S15P11E101-737 후속)
 *
 * @param robotId 대상 로봇 ID
 * @param phase   진행 단계 ("MAPPING" | "IDLE")
 * @param mapping 매핑 진행 중이면 true (phase 의 boolean 편의 필드)
 * @param since   현재 phase 로 전환된 시각. 기록이 없으면(초기 IDLE) null
 */
public record MappingStatusResponse(
        String robotId,
        String phase,
        boolean mapping,
        Instant since
) {
}
