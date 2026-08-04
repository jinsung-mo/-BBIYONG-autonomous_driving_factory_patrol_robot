package com.bbiyong.server.robot.service;

import com.bbiyong.server.robot.domain.RobotHealthHistory;
import com.bbiyong.server.robot.dto.RobotHealthHistoryResponse;
import com.bbiyong.server.robot.dto.RobotResponse;
import com.bbiyong.server.robot.repository.RobotHealthHistoryRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

/**
 * 로봇 건강 이력 서비스
 */
@Slf4j
@Service
public class RobotHealthHistoryService {

    private final RobotHealthHistoryRepository healthHistoryRepository;
    private final RobotService robotService;

    public RobotHealthHistoryService(
            RobotHealthHistoryRepository healthHistoryRepository,
            RobotService robotService) {
        this.healthHistoryRepository = healthHistoryRepository;
        this.robotService = robotService;
    }

    /**
     * 로봇 건강 이력 조회 (기간 기반)
     */
    @Transactional(readOnly = true)
    public RobotHealthHistoryResponse getHealthHistory(String robotId, String period) {
        Instant endTime = Instant.now();
        Instant startTime = calculateStartTime(period);

        List<RobotHealthHistory> histories = healthHistoryRepository
                .findByRobotIdAndTimestampBetweenOrderByTimestampAsc(robotId, startTime, endTime);

        return RobotHealthHistoryResponse.from(robotId, startTime, endTime, histories);
    }

    /**
     * 기간 문자열을 시작 시간으로 변환
     * 지원 형식: "1h", "6h", "24h", "7d", "30d"
     */
    private Instant calculateStartTime(String period) {
        Instant now = Instant.now();
        if (period == null || period.isBlank()) {
            return now.minus(24, ChronoUnit.HOURS); // 기본 24시간
        }

        String periodLower = period.toLowerCase().trim();
        try {
            if (periodLower.endsWith("h")) {
                int hours = Integer.parseInt(periodLower.substring(0, periodLower.length() - 1));
                return now.minus(hours, ChronoUnit.HOURS);
            } else if (periodLower.endsWith("d")) {
                int days = Integer.parseInt(periodLower.substring(0, periodLower.length() - 1));
                return now.minus(days, ChronoUnit.DAYS);
            } else if (periodLower.endsWith("m")) {
                int minutes = Integer.parseInt(periodLower.substring(0, periodLower.length() - 1));
                return now.minus(minutes, ChronoUnit.MINUTES);
            }
        } catch (NumberFormatException e) {
            log.warn("잘못된 기간 형식: {}, 기본값(24h) 사용", period);
        }

        return now.minus(24, ChronoUnit.HOURS);
    }

    /**
     * 로봇 건강 데이터 수집 (1분마다 실행)
     */
    @Scheduled(fixedRate = 60000) // 60초
    @Transactional
    public void collectHealthData() {
        try {
            List<RobotResponse> robots = robotService.getAllRobots();

            for (RobotResponse robot : robots) {
                RobotHealthHistory history = new RobotHealthHistory();
                history.setRobotId(robot.getRobotId());
                history.setTimestamp(Instant.now());
                history.setBattery(robot.getBattery());
                history.setCommLatencyMs(robot.getCommLatencyMs());
                history.setInferenceFps(robot.getInferenceFps());
                history.setStatus(robot.getStatus());
                history.setEstop(robot.getEstop());
                history.setOnline(robot.getOnline());

                healthHistoryRepository.save(history);
            }

            log.debug("로봇 건강 데이터 수집 완료: {}개", robots.size());
        } catch (Exception e) {
            log.error("로봇 건강 데이터 수집 중 오류 발생: {}", e.getMessage(), e);
        }
    }

    /**
     * 오래된 이력 데이터 정리 (매일 자정 실행)
     * 30일 이상 된 데이터 삭제
     */
    @Scheduled(cron = "0 0 0 * * *") // 매일 자정
    @Transactional
    public void cleanupOldData() {
        try {
            Instant cutoffTime = Instant.now().minus(30, ChronoUnit.DAYS);
            healthHistoryRepository.deleteByTimestampBefore(cutoffTime);
            log.info("오래된 로봇 건강 이력 삭제 완료: cutoffTime={}", cutoffTime);
        } catch (Exception e) {
            log.error("로봇 건강 이력 정리 중 오류 발생: {}", e.getMessage(), e);
        }
    }
}
