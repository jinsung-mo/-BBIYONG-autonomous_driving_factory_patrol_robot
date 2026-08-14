package com.bbiyong.server.event.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.EventStatsResponse;
import com.bbiyong.server.event.repository.EventLogRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 이벤트 통계 서비스 (차트용 데이터 제공)
 */
@Slf4j
@Service
public class EventStatsService {

    private final EventLogRepository eventLogRepository;

    public EventStatsService(EventLogRepository eventLogRepository) {
        this.eventLogRepository = eventLogRepository;
    }

    /**
     * 시간별 이벤트 통계 (hourly)
     */
    @Transactional(readOnly = true)
    public EventStatsResponse getHourlyStats(int hours) {
        Instant endTime = Instant.now();
        Instant startTime = endTime.minus(hours, ChronoUnit.HOURS);

        List<EventLog> events = eventLogRepository.findByTimestampAfter(startTime);

        // 시간별로 그룹화
        Map<Instant, List<EventLog>> grouped = events.stream()
                .collect(Collectors.groupingBy(e -> truncateToHour(e.getTimestamp())));

        // 모든 시간대에 대한 데이터 포인트 생성 (데이터가 없는 시간대도 0으로 표시)
        List<EventStatsResponse.DataPoint> dataPoints = new ArrayList<>();
        for (int i = 0; i < hours; i++) {
            Instant hourStart = endTime.minus(hours - i, ChronoUnit.HOURS).truncatedTo(ChronoUnit.HOURS);
            List<EventLog> hourEvents = grouped.getOrDefault(hourStart, Collections.emptyList());
            dataPoints.add(buildDataPoint(formatHour(hourStart), hourStart, hourEvents));
        }

        return EventStatsResponse.builder()
                .groupBy("hour")
                .startTime(startTime)
                .endTime(endTime)
                .dataPoints(dataPoints)
                .build();
    }

    /**
     * 일별 이벤트 통계 (daily)
     */
    @Transactional(readOnly = true)
    public EventStatsResponse getDailyStats(int days) {
        Instant endTime = Instant.now();
        Instant startTime = endTime.minus(days, ChronoUnit.DAYS);

        List<EventLog> events = eventLogRepository.findByTimestampAfter(startTime);

        // 일별로 그룹화
        Map<Instant, List<EventLog>> grouped = events.stream()
                .collect(Collectors.groupingBy(e -> truncateToDay(e.getTimestamp())));

        // 모든 날짜에 대한 데이터 포인트 생성
        List<EventStatsResponse.DataPoint> dataPoints = new ArrayList<>();
        for (int i = 0; i < days; i++) {
            Instant dayStart = endTime.minus(days - i, ChronoUnit.DAYS).truncatedTo(ChronoUnit.DAYS);
            List<EventLog> dayEvents = grouped.getOrDefault(dayStart, Collections.emptyList());
            dataPoints.add(buildDataPoint(formatDay(dayStart), dayStart, dayEvents));
        }

        return EventStatsResponse.builder()
                .groupBy("day")
                .startTime(startTime)
                .endTime(endTime)
                .dataPoints(dataPoints)
                .build();
    }

    /**
     * 로봇별 이벤트 통계
     */
    @Transactional(readOnly = true)
    public EventStatsResponse getStatsByRobot(int days) {
        Instant startTime = Instant.now().minus(days, ChronoUnit.DAYS);
        List<EventLog> events = eventLogRepository.findByTimestampAfter(startTime);

        // 로봇별로 그룹화
        Map<String, List<EventLog>> grouped = events.stream()
                .filter(e -> e.getRobotId() != null)
                .collect(Collectors.groupingBy(EventLog::getRobotId));

        List<EventStatsResponse.DataPoint> dataPoints = grouped.entrySet().stream()
                .map(entry -> buildDataPoint(entry.getKey(), null, entry.getValue()))
                .sorted(Comparator.comparing(EventStatsResponse.DataPoint::getTotalCount).reversed())
                .collect(Collectors.toList());

        return EventStatsResponse.builder()
                .groupBy("robot")
                .startTime(startTime)
                .endTime(Instant.now())
                .dataPoints(dataPoints)
                .build();
    }

    /**
     * 설비별 이벤트 통계 (과열 이벤트)
     */
    @Transactional(readOnly = true)
    public EventStatsResponse getStatsByEquipment(int days) {
        Instant startTime = Instant.now().minus(days, ChronoUnit.DAYS);
        List<EventLog> events = eventLogRepository.findByTimestampAfter(startTime);

        // 설비별로 그룹화 (equipmentId가 있는 경우만)
        Map<String, List<EventLog>> grouped = events.stream()
                .filter(e -> e.getEquipmentId() != null)
                .collect(Collectors.groupingBy(EventLog::getEquipmentId));

        List<EventStatsResponse.DataPoint> dataPoints = grouped.entrySet().stream()
                .map(entry -> buildDataPoint(entry.getKey(), null, entry.getValue()))
                .sorted(Comparator.comparing(EventStatsResponse.DataPoint::getTotalCount).reversed())
                .collect(Collectors.toList());

        return EventStatsResponse.builder()
                .groupBy("equipment")
                .startTime(startTime)
                .endTime(Instant.now())
                .dataPoints(dataPoints)
                .build();
    }

    /**
     * 이벤트 타입별 통계
     */
    @Transactional(readOnly = true)
    public EventStatsResponse getStatsByType(int days) {
        Instant startTime = Instant.now().minus(days, ChronoUnit.DAYS);
        List<EventLog> events = eventLogRepository.findByTimestampAfter(startTime);

        // 타입별로 그룹화
        Map<String, List<EventLog>> grouped = events.stream()
                .collect(Collectors.groupingBy(EventLog::getType));

        List<EventStatsResponse.DataPoint> dataPoints = grouped.entrySet().stream()
                .map(entry -> buildDataPoint(entry.getKey(), null, entry.getValue()))
                .sorted(Comparator.comparing(EventStatsResponse.DataPoint::getTotalCount).reversed())
                .collect(Collectors.toList());

        return EventStatsResponse.builder()
                .groupBy("type")
                .startTime(startTime)
                .endTime(Instant.now())
                .dataPoints(dataPoints)
                .build();
    }

    /**
     * 데이터 포인트 생성
     */
    private EventStatsResponse.DataPoint buildDataPoint(String label, Instant timestamp, List<EventLog> events) {
        long totalCount = events.size();
        long criticalCount = events.stream().filter(e -> "CRITICAL".equals(e.getLevel())).count();
        long warningCount = events.stream().filter(e -> "WARNING".equals(e.getLevel())).count();
        long unresolvedCount = events.stream().filter(e -> "UNRESOLVED".equals(e.getStatus())).count();
        long resolvedCount = events.stream().filter(e -> "RESOLVED".equals(e.getStatus())).count();

        return EventStatsResponse.DataPoint.builder()
                .label(label)
                .timestamp(timestamp)
                .totalCount(totalCount)
                .criticalCount(criticalCount)
                .warningCount(warningCount)
                .unresolvedCount(unresolvedCount)
                .resolvedCount(resolvedCount)
                .build();
    }

    /**
     * 시간 단위로 자르기
     */
    private Instant truncateToHour(Instant instant) {
        return instant.truncatedTo(ChronoUnit.HOURS);
    }

    /**
     * 일 단위로 자르기
     */
    private Instant truncateToDay(Instant instant) {
        return instant.truncatedTo(ChronoUnit.DAYS);
    }

    /**
     * 시간 포맷 (HH:00)
     */
    private String formatHour(Instant instant) {
        ZonedDateTime zdt = instant.atZone(ZoneId.systemDefault());
        return String.format("%02d:00", zdt.getHour());
    }

    /**
     * 날짜 포맷 (MM/DD)
     */
    private String formatDay(Instant instant) {
        ZonedDateTime zdt = instant.atZone(ZoneId.systemDefault());
        return String.format("%02d/%02d", zdt.getMonthValue(), zdt.getDayOfMonth());
    }
}
