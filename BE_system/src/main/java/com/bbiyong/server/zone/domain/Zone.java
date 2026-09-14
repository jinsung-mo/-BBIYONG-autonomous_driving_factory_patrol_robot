package com.bbiyong.server.zone.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * 관리자 정의 구역(Zone). 좌표를 사람이 읽는 이름("창고", "조립 라인")으로 바꾸는 근거 데이터. (S15P11E101-769)
 *
 * <p>영역은 맵 월드 좌표계(미터, ROS map 규약)의 축 정렬 사각형이며,
 * 저장 시 x1&le;x2, y1&le;y2 로 정규화된다.
 */
@Data
@NoArgsConstructor
@Entity
@Table(name = "zones")
public class Zone {

    // MapArtifact 와 동일 사유(SQLite 방언 오토인크리먼트 이슈)로 애플리케이션 할당 UUID 사용.
    @Id
    @Column(length = 36)
    private String id;

    @PrePersist
    void assignId() {
        if (id == null) {
            id = java.util.UUID.randomUUID().toString();
        }
    }

    @Column(nullable = false, length = 80)
    private String name;

    @Column(nullable = false)
    private Double x1;

    @Column(nullable = false)
    private Double y1;

    @Column(nullable = false)
    private Double x2;

    @Column(nullable = false)
    private Double y2;

    @Column(nullable = false)
    private Instant createdAt;

    /** 점 포함 판정(경계 포함). */
    public boolean contains(double x, double y) {
        return x >= x1 && x <= x2 && y >= y1 && y <= y2;
    }

    /** 면적(㎡). 겹칠 때 더 작은(구체적인) 구역을 고르는 기준. */
    public double area() {
        return (x2 - x1) * (y2 - y1);
    }
}
