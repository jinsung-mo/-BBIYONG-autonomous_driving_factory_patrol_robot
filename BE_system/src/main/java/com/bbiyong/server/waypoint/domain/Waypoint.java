package com.bbiyong.server.waypoint.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.UUID;

/**
 * 순찰 지점(waypoint). 관제 웹이 2D 지도 클릭으로 만든 지점을 저장한다. (S15P11E101-509)
 *
 * <p>좌표(x/y/yaw)는 설비·맵·NAVIGATE와 동일한 <b>미터/월드(ROS map) 좌표계</b>다.
 * FE가 클릭 픽셀을 맵 resolution/origin으로 변환한 값을 보낸다.
 * VideoClip/MapArtifact 와 같은 사유(SQLite 방언의 IDENTITY 이슈)로 앱 할당 UUID 를 PK 로 쓴다.
 */
@Data
@NoArgsConstructor
@Entity
@Table(name = "waypoints")
public class Waypoint {

    @Id
    @Column(length = 36)
    private String id;

    @PrePersist
    void assignId() {
        if (id == null) {
            id = UUID.randomUUID().toString();
        }
    }

    private String robotId;
    private String name;

    @Column(nullable = false)
    private Double x;

    @Column(nullable = false)
    private Double y;

    private Double yaw;
    private Integer seq;  // 순찰 순서(오름차순)

    @Column(nullable = false)
    private Instant createdAt;
}
