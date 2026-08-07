package com.bbiyong.server.scheduler.service;

import com.bbiyong.server.scheduler.domain.PatrolSchedule;
import com.bbiyong.server.scheduler.dto.PatrolScheduleRequest;
import com.bbiyong.server.scheduler.dto.PatrolScheduleResponse;
import com.bbiyong.server.scheduler.repository.PatrolScheduleRepository;
import com.bbiyong.server.sync.ResourceChangedEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.support.CronExpression;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 순찰 스케줄 CRUD 서비스
 */
@Slf4j
@Service
public class PatrolScheduleService {

    private final PatrolScheduleRepository scheduleRepository;
    private final PatrolSchedulerService schedulerService;
    private final ApplicationEventPublisher eventPublisher;

    public PatrolScheduleService(
            PatrolScheduleRepository scheduleRepository,
            PatrolSchedulerService schedulerService,
            ApplicationEventPublisher eventPublisher) {
        this.scheduleRepository = scheduleRepository;
        this.schedulerService = schedulerService;
        this.eventPublisher = eventPublisher;
    }

    /**
     * 모든 스케줄 조회
     */
    @Transactional(readOnly = true)
    public List<PatrolScheduleResponse> getAllSchedules() {
        return scheduleRepository.findAll().stream()
                .map(PatrolScheduleResponse::from)
                .collect(Collectors.toList());
    }

    /**
     * 특정 로봇의 스케줄 조회
     */
    @Transactional(readOnly = true)
    public List<PatrolScheduleResponse> getSchedulesByRobotId(String robotId) {
        return scheduleRepository.findByRobotId(robotId).stream()
                .map(PatrolScheduleResponse::from)
                .collect(Collectors.toList());
    }

    /**
     * 스케줄 ID로 조회
     */
    @Transactional(readOnly = true)
    public PatrolScheduleResponse getScheduleById(Long scheduleId) {
        PatrolSchedule schedule = scheduleRepository.findById(scheduleId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "스케줄을 찾을 수 없습니다."));
        return PatrolScheduleResponse.from(schedule);
    }

    /**
     * 새 스케줄 생성
     */
    @Transactional
    public PatrolScheduleResponse createSchedule(PatrolScheduleRequest request) {
        // Cron 표현식 유효성 검사
        validateCronExpression(request.getCronExpression());

        PatrolSchedule schedule = new PatrolSchedule();
        schedule.setName(request.getName());
        schedule.setRobotId(request.getRobotId());
        schedule.setCronExpression(request.getCronExpression());
        schedule.setEnabled(request.getEnabled());

        PatrolSchedule saved = scheduleRepository.save(schedule);
        log.info("순찰 스케줄 생성: scheduleId={}, name={}, robotId={}",
                saved.getScheduleId(), saved.getName(), saved.getRobotId());

        // 활성화된 경우 스케줄러에 등록
        if (saved.getEnabled()) {
            schedulerService.scheduleTask(saved);
        }

        // 다른 접속자의 스케줄 목록도 같이 갱신되도록 알린다(/topic/sync).
        eventPublisher.publishEvent(new ResourceChangedEvent("patrol-schedules", saved.getRobotId()));
        return PatrolScheduleResponse.from(saved);
    }

    /**
     * 스케줄 수정
     */
    @Transactional
    public PatrolScheduleResponse updateSchedule(Long scheduleId, PatrolScheduleRequest request) {
        PatrolSchedule schedule = scheduleRepository.findById(scheduleId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "스케줄을 찾을 수 없습니다."));

        // Cron 표현식 유효성 검사
        validateCronExpression(request.getCronExpression());

        boolean cronChanged = !schedule.getCronExpression().equals(request.getCronExpression());
        boolean enabledChanged = !schedule.getEnabled().equals(request.getEnabled());

        schedule.setName(request.getName());
        schedule.setRobotId(request.getRobotId());
        schedule.setCronExpression(request.getCronExpression());
        schedule.setEnabled(request.getEnabled());

        PatrolSchedule saved = scheduleRepository.save(schedule);
        log.info("순찰 스케줄 수정: scheduleId={}, name={}", saved.getScheduleId(), saved.getName());

        // Cron 표현식 변경 또는 활성화 상태 변경 시 재등록
        if (cronChanged || enabledChanged) {
            schedulerService.cancelTask(scheduleId);
            if (saved.getEnabled()) {
                schedulerService.scheduleTask(saved);
            }
        }

        eventPublisher.publishEvent(new ResourceChangedEvent("patrol-schedules", saved.getRobotId()));
        return PatrolScheduleResponse.from(saved);
    }

    /**
     * 스케줄 삭제
     */
    @Transactional
    public void deleteSchedule(Long scheduleId) {
        PatrolSchedule schedule = scheduleRepository.findById(scheduleId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "스케줄을 찾을 수 없습니다."));

        schedulerService.cancelTask(scheduleId);
        scheduleRepository.delete(schedule);
        log.info("순찰 스케줄 삭제: scheduleId={}, name={}", scheduleId, schedule.getName());
        eventPublisher.publishEvent(new ResourceChangedEvent("patrol-schedules", schedule.getRobotId()));
    }

    /**
     * Cron 표현식 유효성 검사
     */
    private void validateCronExpression(String cronExpression) {
        try {
            CronExpression.parse(cronExpression);
        } catch (Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "잘못된 Cron 표현식입니다: " + e.getMessage());
        }
    }
}
