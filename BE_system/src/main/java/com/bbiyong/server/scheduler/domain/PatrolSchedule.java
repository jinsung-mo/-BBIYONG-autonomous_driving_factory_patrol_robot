package com.bbiyong.server.scheduler.domain;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * 자동 순찰 스케줄 설정
 * 특정 로봇이 특정 시간에 자동으로 순찰을 시작하도록 예약
 */
@Data
@NoArgsConstructor
@Entity
@Table(name = "patrol_schedules")
public class PatrolSchedule {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long scheduleId;

    @Column(nullable = false)
    private String name; // 스케줄 이름 (예: "주간 순찰", "야간 점검")

    @Column(nullable = false)
    private String robotId; // 순찰을 수행할 로봇 ID

    @Column(nullable = false)
    private String cronExpression; // Cron 표현식 (예: "0 0 9 * * MON-FRI" - 평일 오전 9시)

    @Column(nullable = false)
    private Boolean enabled = true; // 스케줄 활성화 여부

    private Instant lastExecuted; // 마지막 실행 시각

    private Instant createdAt;
    private Instant updatedAt;

    @PrePersist
    protected void onCreate() {
        createdAt = Instant.now();
        updatedAt = Instant.now();
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }
}
