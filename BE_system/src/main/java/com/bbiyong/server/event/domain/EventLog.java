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

    /** 로봇이 재전송해도 변하지 않는 이벤트 멱등 키. 기존 이력은 null이다. */
    @Column(unique = true, length = 64)
    private String messageId;

    private String equipmentId; // OVERHEAT 전용 — 과열이 감지된 설비 식별자

    private Double x;
    private Double y;

    /**
     * x,y 가 찍힌 지도(저장 시점의 활성 맵) id. 활성 맵이 없었거나 과거 이력이면 null.
     *
     * <p>좌표는 map 프레임 기준인데 재매핑하면 SLAM 원점이 새로 잡힌다 — 어느 지도의
     * 좌표인지 모르면 관제가 이전 지도의 화재를 새 도면 위에 그리게 된다. 이력 자체는
     * 지우지 않고(감사 기록·이벤트 영상), 지도에 그릴지를 이 값으로 가른다.
     */
    @Column(length = 36)
    private String mapId;

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
