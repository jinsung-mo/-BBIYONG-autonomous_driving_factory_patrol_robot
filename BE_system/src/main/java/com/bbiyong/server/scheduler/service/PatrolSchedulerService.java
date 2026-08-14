package com.bbiyong.server.scheduler.service;

import com.bbiyong.server.scheduler.domain.PatrolSchedule;
import com.bbiyong.server.scheduler.repository.PatrolScheduleRepository;
import com.bbiyong.server.waypoint.service.WaypointService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.support.CronTrigger;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;

/**
 * 자동 순찰 스케줄러 서비스
 * 등록된 스케줄에 따라 자동으로 순찰 경로를 로봇에 하달
 */
@Slf4j
@Service
public class PatrolSchedulerService {

    private final PatrolScheduleRepository scheduleRepository;
    private final WaypointService waypointService;
    private final TaskScheduler taskScheduler;

    // 자동 순찰 스케줄 발동 on/off (S15P11E101-850 콘솔 정리로 자동 순찰 스케줄 기능 제거).
    // 기본 OFF — DB 에 남은 활성 스케줄이 있어도 cron 등록을 하지 않아 자동 순찰이 발동되지 않는다.
    // 다시 켜려면 BBIYONG_PATROL_SCHEDULER_ENABLED=true 로 주입한다.
    private final boolean schedulerEnabled;

    // 스케줄 ID -> ScheduledFuture 매핑 (스케줄 취소용)
    private final Map<Long, ScheduledFuture<?>> scheduledTasks = new ConcurrentHashMap<>();

    public PatrolSchedulerService(
            PatrolScheduleRepository scheduleRepository,
            WaypointService waypointService,
            TaskScheduler taskScheduler,
            @Value("${bbiyong.patrol.scheduler.enabled:false}") boolean schedulerEnabled) {
        this.scheduleRepository = scheduleRepository;
        this.waypointService = waypointService;
        this.taskScheduler = taskScheduler;
        this.schedulerEnabled = schedulerEnabled;
    }

    /**
     * 애플리케이션 시작 시 활성화된 모든 스케줄 로드.
     * 스케줄러가 꺼져 있으면(기본값) 아무것도 등록하지 않는다 — 서버 재기동으로도 자동 순찰이 되살아나지 않는다.
     */
    @PostConstruct
    public void loadSchedules() {
        if (!schedulerEnabled) {
            log.info("자동 순찰 스케줄러 비활성화(bbiyong.patrol.scheduler.enabled=false) — 스케줄을 등록하지 않습니다.");
            return;
        }
        log.info("순찰 스케줄 로딩 시작");
        List<PatrolSchedule> activeSchedules = scheduleRepository.findByEnabledTrue();
        for (PatrolSchedule schedule : activeSchedules) {
            scheduleTask(schedule);
        }
        log.info("순찰 스케줄 로딩 완료: {}개", activeSchedules.size());
    }

    /**
     * 애플리케이션 종료 시 모든 스케줄 취소
     */
    @PreDestroy
    public void cancelAllSchedules() {
        log.info("모든 순찰 스케줄 취소 중");
        scheduledTasks.values().forEach(future -> future.cancel(false));
        scheduledTasks.clear();
    }

    /**
     * 특정 스케줄을 TaskScheduler에 등록
     */
    public void scheduleTask(PatrolSchedule schedule) {
        if (!schedulerEnabled) {
            log.info("자동 순찰 스케줄러 비활성화 — 등록 건너뜀: scheduleId={}", schedule.getScheduleId());
            return;
        }
        try {
            CronTrigger cronTrigger = new CronTrigger(schedule.getCronExpression());

            ScheduledFuture<?> future = taskScheduler.schedule(
                    () -> executePatrol(schedule.getScheduleId()),
                    cronTrigger
            );

            scheduledTasks.put(schedule.getScheduleId(), future);
            log.info("스케줄 등록: scheduleId={}, name={}, cron={}, robotId={}",
                    schedule.getScheduleId(), schedule.getName(), schedule.getCronExpression(), schedule.getRobotId());
        } catch (Exception e) {
            log.error("스케줄 등록 실패: scheduleId={}, error={}",
                    schedule.getScheduleId(), e.getMessage(), e);
        }
    }

    /**
     * 특정 스케줄 취소
     */
    public void cancelTask(Long scheduleId) {
        ScheduledFuture<?> future = scheduledTasks.remove(scheduleId);
        if (future != null) {
            future.cancel(false);
            log.info("스케줄 취소: scheduleId={}", scheduleId);
        }
    }

    /**
     * 스케줄된 순찰 실행 로직
     */
    @Transactional
    protected void executePatrol(Long scheduleId) {
        try {
            PatrolSchedule schedule = scheduleRepository.findById(scheduleId).orElse(null);
            if (schedule == null || !schedule.getEnabled()) {
                log.warn("스케줄이 비활성화되었거나 삭제됨: scheduleId={}", scheduleId);
                cancelTask(scheduleId);
                return;
            }

            log.info("자동 순찰 실행: scheduleId={}, name={}, robotId={}",
                    schedule.getScheduleId(), schedule.getName(), schedule.getRobotId());

            // 순찰 경로 하달(SET_PATROL_ROUTE) + 순찰 시작(SET_MODE autonomy).
            // 로봇 계약상 경로 하달만으로는 순찰이 시작되지 않으므로 startPatrol 로 시작까지 처리한다. (S15P11E101-620)
            var result = waypointService.startPatrol(schedule.getRobotId());
            if (!result.patrolStarted()) {
                log.warn("자동 순찰 시작 미완료: scheduleId={}, robotId={}, status={}, routeDelivered={}",
                        schedule.getScheduleId(), schedule.getRobotId(), result.status(), result.routeDelivered());
            }

            // 마지막 실행 시각 업데이트
            schedule.setLastExecuted(Instant.now());
            scheduleRepository.save(schedule);

            log.info("자동 순찰 실행 완료: scheduleId={}, robotId={}", schedule.getScheduleId(), schedule.getRobotId());
        } catch (Exception e) {
            log.error("자동 순찰 실행 중 오류 발생: scheduleId={}, error={}",
                    scheduleId, e.getMessage(), e);
        }
    }
}
