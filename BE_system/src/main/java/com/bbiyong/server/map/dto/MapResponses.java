package com.bbiyong.server.map.dto;

import com.bbiyong.server.map.domain.MapArtifact;

import java.util.List;

/**
 * 맵 아카이브 응답 DTO 모음. imageUrl 은 서버가 서빙하는 이미지 API 경로다.
 */
public final class MapResponses {

    private MapResponses() {}

    private static String imageUrlFor(MapArtifact m) {
        return "/api/maps/" + m.getId() + "/image";
    }

    public record RegisterResult(String id, String name, String robotId, String status, String createdAt) {
        public static RegisterResult of(MapArtifact m) {
            return new RegisterResult(m.getId(), m.getName(), m.getRobotId(), "REGISTERED",
                    m.getCreatedAt() != null ? m.getCreatedAt().toString() : null);
        }
    }

    private static boolean isActive(MapArtifact m) {
        return Boolean.TRUE.equals(m.getActive());
    }

    private static String kindOf(MapArtifact m) {
        return m.getKind() != null ? m.getKind() : "RAW";
    }

    public record Summary(String id, String name, String robotId, String imageUrl,
                          boolean active, String kind, String createdAt) {
        public static Summary of(MapArtifact m) {
            return new Summary(m.getId(), m.getName(), m.getRobotId(), imageUrlFor(m),
                    isActive(m), kindOf(m),
                    m.getCreatedAt() != null ? m.getCreatedAt().toString() : null);
        }
    }

    public record Detail(String id, String name, String robotId, String imageUrl,
                         Integer widthPx, Integer heightPx, Double resolution,
                         Double originX, Double originY, Double originYaw,
                         Long fileSizeBytes, boolean active, String kind, String sourceMapId,
                         String createdAt) {
        public static Detail of(MapArtifact m) {
            return new Detail(m.getId(), m.getName(), m.getRobotId(), imageUrlFor(m),
                    m.getWidthPx(), m.getHeightPx(), m.getResolution(),
                    m.getOriginX(), m.getOriginY(), m.getOriginYaw(),
                    m.getFileSizeBytes(), isActive(m), kindOf(m), m.getSourceMapId(),
                    m.getCreatedAt() != null ? m.getCreatedAt().toString() : null);
        }
    }

    public static List<Summary> summaries(List<MapArtifact> list) {
        return list.stream().map(Summary::of).toList();
    }
}
