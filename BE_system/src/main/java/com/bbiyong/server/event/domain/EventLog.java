package com.bbiyong.server.event.domain;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@NoArgsConstructor
@Entity
@Table(name = "event_logs")
public class EventLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long eventId;

    @Column(nullable = false)
    private String type; // "FIRE", "OVERHEAT", "SYSTEM"

    private String level; // "CRITICAL"(화재) | "WARNING"(과열) — 실시간 AlertMessage 와 일치

    private String robotId;

    private String equipmentId; // OVERHEAT 전용 — 과열이 감지된 설비 식별자

    private Double x;
    private Double y;

    private Double confidence;  // FIRE 전용
    private Double temperature;
    private Double threshold;   // OVERHEAT 전용 — 로봇 판정 임계 온도(℃)

    @Column(length = 1000)
    private String message;     // 사람이 읽는 경보 메시지 (AlertMessage 와 동일 문구)

    @Column(nullable = false)
    private Instant timestamp;

    @Column(nullable = false)
    private String status; // "UNRESOLVED", "RESOLVED"

    /** 시연 API가 생성한 이벤트인지 구분한다. 실제 경보와 혼동되지 않도록 외부 알림에도 표기한다. */
    @Column(nullable = false, columnDefinition = "boolean default false")
    private boolean simulated = false;
}
