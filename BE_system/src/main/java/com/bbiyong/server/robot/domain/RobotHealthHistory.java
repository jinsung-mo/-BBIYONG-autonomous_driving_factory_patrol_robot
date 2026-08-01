package com.bbiyong.server.robot.domain;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * 로봇 건강 상태 이력
 * 배터리, 통신 지연, 추론 FPS 등의 시계열 데이터
 */
@Data
@NoArgsConstructor
@Entity
@Table(name = "robot_health_history", indexes = {
        @Index(name = "idx_robot_timestamp", columnList = "robotId,timestamp")
})
public class RobotHealthHistory {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String robotId;

    @Column(nullable = false)
    private Instant timestamp;

    private Double battery; // 배터리 잔량 (%)
    private Double speed; // 이동 속도 (m/s)
    private Integer commLatencyMs; // 통신 지연 시간 (ms)
    private Double inferenceFps; // AI 추론 FPS
    private String status; // 로봇 상태 (AUTO_PATROL, MANUAL_CONTROL, CHARGING, IDLE, ERROR)
    private String estop; // 비상정지 상태 (NONE, SOFTWARE, HARDWARE)
    private Boolean online; // 연결 상태

    @PrePersist
    protected void onCreate() {
        if (timestamp == null) {
            timestamp = Instant.now();
        }
    }
}
