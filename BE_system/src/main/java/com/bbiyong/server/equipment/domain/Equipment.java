package com.bbiyong.server.equipment.domain;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@NoArgsConstructor
@Entity
@Table(name = "equipments")
public class Equipment {

    @Id
    private String equipmentId; // 예: panel_A

    @Column(nullable = false)
    private String name;

    private Double x;
    private Double y;

    // 로봇이 판정에 사용하는 임계치의 표시용 참고값 (authoritative 값은 로봇 보유)
    private Double threshold;

    // 최근 점검 결과
    private Double lastTemperature;
    private Instant lastInspectedAt;

    @Column(nullable = false)
    private String status; // NORMAL | OVER | UNKNOWN
}
