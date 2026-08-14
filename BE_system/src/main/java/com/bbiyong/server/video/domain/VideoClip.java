package com.bbiyong.server.video.domain;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/**
 * 순찰 영상 클립 메타데이터. 원본 영상은 파일시스템(MVP)/S3(고도화)에 저장하고 본 엔티티는 메타데이터만 보관한다. (설계 S15P11E101-329)
 */
@Data
@NoArgsConstructor
@Entity
@Table(name = "video_clips")
public class VideoClip {

    // ID: 애플리케이션 할당 UUID(String).
    // hibernate-community SQLite 방언은 "숫자형 비-id 컬럼(event_id/duration_sec/file_size_bytes)이 있는 엔티티"의
    // IDENTITY id 컬럼 타입을 비워 SQLite 오토인크리먼트가 깨지는 버그가 있고, TABLE 전략도 SQLite에서 실패한다.
    // Equipment처럼 String @Id는 정상 동작하므로, DB 시퀀스/오토인크리먼트에 의존하지 않는 UUID로 안전하게 채운다.
    @Id
    @Column(length = 36)
    private String id;

    @PrePersist
    void assignId() {
        if (id == null) {
            id = java.util.UUID.randomUUID().toString();
        }
    }

    @Column(nullable = false)
    private String robotId;

    private Long eventId; // 연관 이벤트(event_logs), nullable

    @Column(nullable = false)
    private String clipType;    // EVENT | PATROL | MANUAL

    @Column(nullable = false)
    private String storageType; // FILESYSTEM | S3

    @Column(nullable = false, length = 512)
    private String filePath;    // 파일 경로 또는 S3 Key/URL

    @Column(length = 512)
    private String thumbnailPath;

    private Integer durationSec;
    private Long fileSizeBytes;

    @Column(nullable = false)
    private Instant startedAt;

    private Instant endedAt;

    @Column(nullable = false)
    private Instant createdAt;
}
