package com.bbiyong.server.stats.dto;

import java.time.Instant;
import java.util.List;

/**
 * 통계 대시보드 집계 응답 모음. (S15P11E101-767)
 *
 * <p>설비별 과열 랭킹은 "어느 분전반을 예방 점검해야 하나",
 * 주간 추이는 "위험이 늘고 있나", 배터리 추세는 "얼마나 더 돌 수 있나"에 답한다.
 */
public final class StatsResponses {

    private StatsResponses() {
    }

    /** 설비별 과열 이벤트 랭킹. */
    public record OverheatEquipment(int periodDays, long totalCount, List<OverheatItem> items) {
    }

    /**
     * @param equipmentId 설비 ID (이벤트에 설비 정보가 없으면 "unknown")
     * @param name        설비 표시명 (미등록 설비는 equipmentId 폴백)
     * @param count       기간 내 과열 이벤트 수
     * @param lastAt      마지막 발생 시각
     */
    public record OverheatItem(String equipmentId, String name, long count, Instant lastAt) {
    }

    /** 일별 경보 추이(빈 날짜는 0으로 채움). */
    public record AlertsWeekly(int periodDays, List<AlertsDay> items) {
    }

    /** @param date ISO 로컬 날짜(Asia/Seoul 기준, 예: 2026-08-06) */
    public record AlertsDay(String date, long fire, long overheat, long total) {
    }

    /**
     * 배터리 방전 추세와 예상 잔여 가동시간.
     *
     * @param battery                   최신 배터리(%)
     * @param dischargePerHour          시간당 방전율(%/h, 방전이면 양수). 추정 불가 시 null
     * @param estimatedRemainingMinutes 예상 잔여 가동시간(분). 충전 중/데이터 부족이면 null
     * @param basisMinutes              추정에 사용한 관측 구간 길이(분)
     */
    public record BatteryEstimate(String robotId, Double battery, Double dischargePerHour,
                                  Long estimatedRemainingMinutes, Integer basisMinutes) {
    }
}
