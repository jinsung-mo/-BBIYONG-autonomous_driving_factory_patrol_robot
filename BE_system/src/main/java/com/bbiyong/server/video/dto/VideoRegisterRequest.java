package com.bbiyong.server.video.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.time.Instant;

public record VideoRegisterRequest(
        @NotBlank String robotId,
        Long eventId,
        @NotBlank String clipType,     // EVENT | PATROL | MANUAL
        @NotBlank String storageType,  // FILESYSTEM | S3
        @NotBlank String filePath,
        String thumbnailPath,
        Integer durationSec,
        Long fileSizeBytes,
        @NotNull Instant startedAt,
        Instant endedAt
) {
}
