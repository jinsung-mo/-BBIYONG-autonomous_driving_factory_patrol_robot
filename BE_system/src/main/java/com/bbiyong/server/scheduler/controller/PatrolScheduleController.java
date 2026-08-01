package com.bbiyong.server.scheduler.controller;

import com.bbiyong.server.scheduler.dto.PatrolScheduleRequest;
import com.bbiyong.server.scheduler.dto.PatrolScheduleResponse;
import com.bbiyong.server.scheduler.service.PatrolScheduleService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * 자동 순찰 스케줄 관리 API
 */
@Slf4j
@RestController
@RequestMapping("/api/patrol-schedules")
@Tag(name = "Patrol Schedules", description = "자동 순찰 스케줄 관리 API")
public class PatrolScheduleController {

    private final PatrolScheduleService scheduleService;

    public PatrolScheduleController(PatrolScheduleService scheduleService) {
        this.scheduleService = scheduleService;
    }

    /**
     * 모든 스케줄 조회
     */
    @GetMapping
    @Operation(summary = "모든 스케줄 조회", description = "등록된 모든 순찰 스케줄을 조회합니다.")
    public ResponseEntity<List<PatrolScheduleResponse>> getAllSchedules(
            @RequestParam(required = false) String robotId) {
        if (robotId != null && !robotId.isBlank()) {
            return ResponseEntity.ok(scheduleService.getSchedulesByRobotId(robotId));
        }
        return ResponseEntity.ok(scheduleService.getAllSchedules());
    }

    /**
     * 특정 스케줄 조회
     */
    @GetMapping("/{scheduleId}")
    @Operation(summary = "스케줄 상세 조회", description = "특정 스케줄의 상세 정보를 조회합니다.")
    public ResponseEntity<PatrolScheduleResponse> getScheduleById(@PathVariable Long scheduleId) {
        return ResponseEntity.ok(scheduleService.getScheduleById(scheduleId));
    }

    /**
     * 새 스케줄 생성
     */
    @PostMapping
    @Operation(summary = "스케줄 생성", description = "새로운 순찰 스케줄을 생성합니다. Cron 표현식 예: '0 0 9 * * MON-FRI' (평일 오전 9시)")
    public ResponseEntity<PatrolScheduleResponse> createSchedule(
            @Valid @RequestBody PatrolScheduleRequest request) {
        PatrolScheduleResponse response = scheduleService.createSchedule(request);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    /**
     * 스케줄 수정
     */
    @PutMapping("/{scheduleId}")
    @Operation(summary = "스케줄 수정", description = "기존 스케줄을 수정합니다. Cron 표현식 변경 시 자동으로 재등록됩니다.")
    public ResponseEntity<PatrolScheduleResponse> updateSchedule(
            @PathVariable Long scheduleId,
            @Valid @RequestBody PatrolScheduleRequest request) {
        PatrolScheduleResponse response = scheduleService.updateSchedule(scheduleId, request);
        return ResponseEntity.ok(response);
    }

    /**
     * 스케줄 삭제
     */
    @DeleteMapping("/{scheduleId}")
    @Operation(summary = "스케줄 삭제", description = "스케줄을 삭제하고 예약된 작업을 취소합니다.")
    public ResponseEntity<Void> deleteSchedule(@PathVariable Long scheduleId) {
        scheduleService.deleteSchedule(scheduleId);
        return ResponseEntity.noContent().build();
    }
}
