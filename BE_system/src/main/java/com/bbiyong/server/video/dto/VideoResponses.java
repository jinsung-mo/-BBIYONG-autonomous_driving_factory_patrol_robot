package com.bbiyong.server.video.dto;

import com.bbiyong.server.video.domain.VideoClip;
import org.springframework.data.domain.Page;

import java.time.Instant;
import java.util.List;

/**
 * 영상 아카이브 응답 DTO 모음. 원본 파일은 저장하지 않으며 URL은 메타 경로 기반이다.
 * MVP: playbackUrl/thumbnailUrl = 저장 경로. (S3 presigned URL은 후속)
 */
public final class VideoResponses {

    private VideoResponses() {}

    public record RegisterResult(String id, String robotId, Long eventId, String status, String createdAt) {
        public static RegisterResult of(VideoClip v) {
            return new RegisterResult(v.getId(), v.getRobotId(), v.getEventId(), "REGISTERED",
                    v.getCreatedAt() != null ? v.getCreatedAt().toString() : null);
        }
    }

    public record Summary(String id, String robotId, Long eventId, String clipType,
                          Integer durationSec, String thumbnailUrl, String startedAt) {
        public static Summary of(VideoClip v) {
            return new Summary(v.getId(), v.getRobotId(), v.getEventId(), v.getClipType(),
                    v.getDurationSec(), v.getThumbnailPath(),
                    v.getStartedAt() != null ? v.getStartedAt().toString() : null);
        }
    }

    public record Detail(String id, String robotId, Long eventId, String clipType, String storageType,
                         Integer durationSec, Long fileSizeBytes, String playbackUrl, String thumbnailUrl,
                         String startedAt, String endedAt) {
        public static Detail of(VideoClip v) {
            return new Detail(v.getId(), v.getRobotId(), v.getEventId(), v.getClipType(), v.getStorageType(),
                    v.getDurationSec(), v.getFileSizeBytes(),
                    v.getFilePath(), v.getThumbnailPath(),
                    v.getStartedAt() != null ? v.getStartedAt().toString() : null,
                    v.getEndedAt() != null ? v.getEndedAt().toString() : null);
        }
    }

    public record PageResult(List<Summary> content, int page, int size, int totalPages, long totalElements) {
        public static PageResult of(Page<VideoClip> p) {
            return new PageResult(p.getContent().stream().map(Summary::of).toList(),
                    p.getNumber(), p.getSize(), p.getTotalPages(), p.getTotalElements());
        }
    }
}
