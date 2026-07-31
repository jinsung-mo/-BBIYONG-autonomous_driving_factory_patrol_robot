package com.bbiyong.server.map.domain;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * 2D SLAM 맵 산출물 메타데이터. 원본 이미지는 파일시스템(MVP)에 저장하고 본 엔티티는 메타데이터만 보관한다.
 * resolution/origin 은 FE 가 맵 이미지를 로봇 미터 좌표계에 정렬(overlay)할 때 사용한다. (설계 S15P11E101-329)
 */
@Data
@NoArgsConstructor
@Entity
@Table(name = "map_artifacts")
public class MapArtifact {

    // VideoClip 과 동일 사유: hibernate-community SQLite 방언은 숫자형 비-id 컬럼이 있는 엔티티의
    // IDENTITY id 에서 오토인크리먼트가 깨지므로, 애플리케이션 할당 UUID(String) 를 사용한다.
    @Id
    @Column(length = 36)
    private String id;

    @PrePersist
    void assignId() {
        if (id == null) {
            id = java.util.UUID.randomUUID().toString();
        }
    }

    private String robotId;

    @Column(nullable = false)
    private String name;         // 맵 이름 (예: factory_01)

    @Column(nullable = false)
    private String storageType;  // FILESYSTEM

    @Column(nullable = false, length = 512)
    private String filePath;     // baseDir 기준 상대 경로

    private Integer widthPx;
    private Integer heightPx;
    private Double resolution;   // meters per pixel
    private Double originX;      // 맵 원점(월드 좌표, ROS map 규약)
    private Double originY;
    private Double originYaw;

    private Long fileSizeBytes;

    // 활성 맵 지정(단일 활성). null/false=비활성. 마이그레이션 안전 위해 nullable wrapper 사용. (S15P11E101-482)
    private Boolean active;

    @Column(nullable = false)
    private Instant createdAt;
}
