package com.bbiyong.server.video.dto;

import java.time.Instant;

/**
 * multipart 업로드(POST /api/videos/upload)의 메타데이터 파트.
 * 파일 바이트는 별도 file/thumbnail 파트로 전송되며, storageType 은 서버가 FILESYSTEM 으로 강제한다.
 */
public record VideoUploadRequest(
        String robotId,
        Long eventId,
        String clipType,     // EVENT | PATROL | MANUAL (미지정 시 PATROL)
        Integer durationSec,
        Instant startedAt,   // 미지정 시 서버 수신 시각
        Instant endedAt
) {
}
