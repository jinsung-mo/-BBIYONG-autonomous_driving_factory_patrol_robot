package com.bbiyong.server.stats.service;

import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.robot.domain.RobotHealthHistory;
import com.bbiyong.server.robot.repository.RobotHealthHistoryRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import com.bbiyong.server.stats.dto.StatsResponses.AlertsDay;
import com.bbiyong.server.stats.dto.StatsResponses.AlertsWeekly;
import com.bbiyong.server.stats.dto.StatsResponses.BatteryEstimate;
import com.bbiyong.server.stats.dto.StatsResponses.OverheatEquipment;
import com.bbiyong.server.stats.dto.StatsResponses.OverheatItem;

/**
 * 통계 대시보드 집계. (S15P11E101-767)
 *
 * <p>이벤트·이력 데이터 규모(수천 건)에서는 DB 그룹핑 대신 조회 후 자바 집계로 충분하며,
 * 날짜 버킷팅(Asia/Seoul)·빈 날짜 0 채움 같은 표현 규칙을 방언 걱정 없이 다룰 수 있다.
 */
@Service
public class StatsService {

    static final ZoneId ZONE = ZoneId.of("Asia/Seoul");
    static final String TYPE_FIRE = "FIRE";
    static final String TYPE_OVERHEAT = "OVERHEAT";

    /** 방전 추정에 필요한 최소 관측 포인트/구간. 그 미만이면 정직하게 null 을 반환한다. */
    static final int MIN_POINTS = 5;
    static final long MIN_SPAN_MINUTES = 10;
    /** 이보다 완만하면(또는 상승이면) 충전/정체로 보고 잔여시간을 추정하지 않는다(%/h). */
    static final double MIN_DISCHARGE_PER_HOUR = 0.5;

    private final EventLogRepository eventRepository;
    private final EquipmentRepository equipmentRepository;
    private final RobotHealthHistoryRepository healthRepository;

    public StatsService(EventLogRepository eventRepository,
                        EquipmentRepository equipmentRepository,
                        RobotHealthHistoryRepository healthRepository) {
        this.eventRepository = eventRepository;
        this.equipmentRepository = equipmentRepository;
        this.healthRepository = healthRepository;
    }

    /** 기간 내 설비별 과열 이벤트 랭킹(최다 순). 시연용 simulated 이벤트는 기본 제외. */
    @Transactional(readOnly = true)
    public OverheatEquipment overheatByEquipment(int days, boolean includeSimulated) {
        int periodDays = clampDays(days);
        Instant since = Instant.now().minus(Duration.ofDays(periodDays));
        List<EventLog> overheats = eventRepository.findByTimestampAfter(since).stream()
                .filter(e -> TYPE_OVERHEAT.equalsIgnoreCase(e.getType()))
                .filter(e -> includeSimulated || !e.isSimulated())
                .toList();

        Map<String, String> names = equipmentRepository.findAll().stream()
                .collect(Collectors.toMap(Equipment::getEquipmentId, Equipment::getName, (a, b) -> a));

        Map<String, List<EventLog>> byEquipment = overheats.stream()
                .collect(Collectors.groupingBy(
                        e -> e.getEquipmentId() != null ? e.getEquipmentId() : "unknown",
                        LinkedHashMap::new, Collectors.toList()));

        List<OverheatItem> items = byEquipment.entrySet().stream()
                .map(entry -> new OverheatItem(
                        entry.getKey(),
                        names.getOrDefault(entry.getKey(), entry.getKey()),
                        entry.getValue().size(),
                        entry.getValue().stream().map(EventLog::getTimestamp)
                                .max(Comparator.naturalOrder()).orElse(null)))
                .sorted(Comparator.comparingLong(OverheatItem::count).reversed()
                        .thenComparing(OverheatItem::equipmentId))
                .toList();

        return new OverheatEquipment(periodDays, overheats.size(), items);
    }

    /** 최근 N일 일별 화재/과열 추이. 이벤트가 없는 날도 0으로 채워 축이 끊기지 않게 한다. */
    @Transactional(readOnly = true)
    public AlertsWeekly alertsWeekly(int days, boolean includeSimulated) {
        int periodDays = clampDays(days);
        LocalDate today = LocalDate.now(ZONE);
        LocalDate start = today.minusDays(periodDays - 1L);
        Instant since = start.atStartOfDay(ZONE).toInstant();

        Map<LocalDate, List<EventLog>> byDate = eventRepository.findByTimestampAfter(since).stream()
                .filter(e -> includeSimulated || !e.isSimulated())
                .filter(e -> e.getTimestamp() != null)
                .collect(Collectors.groupingBy(e -> LocalDate.ofInstant(e.getTimestamp(), ZONE)));

        List<AlertsDay> items = new ArrayList<>(periodDays);
        for (LocalDate d = start; !d.isAfter(today); d = d.plusDays(1)) {
            List<EventLog> dayEvents = byDate.getOrDefault(d, List.of());
            long fire = dayEvents.stream().filter(e -> TYPE_FIRE.equalsIgnoreCase(e.getType())).count();
            long overheat = dayEvents.stream().filter(e -> TYPE_OVERHEAT.equalsIgnoreCase(e.getType())).count();
            items.add(new AlertsDay(d.toString(), fire, overheat, dayEvents.size()));
        }
        return new AlertsWeekly(periodDays, items);
    }

    /**
     * 최근 이력의 선형회귀 기울기로 방전율을 추정한다.
     * 충전 중이거나(기울기 상승/정체) 표본이 부족하면 추정치를 내지 않는다 — 틀린 숫자보다 없는 숫자가 낫다.
     */
    @Transactional(readOnly = true)
    public BatteryEstimate batteryEstimate(String robotId, int limit) {
        List<RobotHealthHistory> recent = healthRepository.findRecentByRobotId(robotId, Math.max(MIN_POINTS, limit));
        List<RobotHealthHistory> points = recent.stream()
                .filter(h -> h.getBattery() != null && h.getTimestamp() != null)
                .sorted(Comparator.comparing(RobotHealthHistory::getTimestamp))
                .toList();

        Double latest = points.isEmpty() ? null : points.get(points.size() - 1).getBattery();
        if (points.size() < MIN_POINTS) {
            return new BatteryEstimate(robotId, latest, null, null, (int) spanMinutes(points));
        }
        long span = spanMinutes(points);
        if (span < MIN_SPAN_MINUTES) {
            return new BatteryEstimate(robotId, latest, null, null, (int) span);
        }

        double slopePerHour = regressionSlopePerHour(points);
        if (slopePerHour >= -MIN_DISCHARGE_PER_HOUR) {
            // 충전 중이거나 소모가 관측 오차 수준 — 잔여시간을 지어내지 않는다.
            return new BatteryEstimate(robotId, latest, null, null, (int) span);
        }
        double dischargePerHour = -slopePerHour;
        long remainingMinutes = Math.round(latest / dischargePerHour * 60.0);
        return new BatteryEstimate(robotId, latest, round1(dischargePerHour), remainingMinutes, (int) span);
    }

    /** 최소제곱 선형회귀 기울기(%/h). x=경과시간(h), y=배터리(%). */
    private static double regressionSlopePerHour(List<RobotHealthHistory> points) {
        Instant t0 = points.get(0).getTimestamp();
        Function<RobotHealthHistory, Double> hours =
                h -> Duration.between(t0, h.getTimestamp()).toMillis() / 3_600_000.0;
        int n = points.size();
        double sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        for (RobotHealthHistory p : points) {
            double x = hours.apply(p);
            double y = p.getBattery();
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumXX += x * x;
        }
        double denominator = n * sumXX - sumX * sumX;
        if (denominator == 0) {
            return 0;
        }
        return (n * sumXY - sumX * sumY) / denominator;
    }

    private static long spanMinutes(List<RobotHealthHistory> points) {
        if (points.size() < 2) {
            return 0;
        }
        return Duration.between(points.get(0).getTimestamp(),
                points.get(points.size() - 1).getTimestamp()).toMinutes();
    }

    private static double round1(double v) {
        return Math.round(v * 10.0) / 10.0;
    }

    private static int clampDays(int days) {
        return Math.max(1, Math.min(31, days));
    }
}
