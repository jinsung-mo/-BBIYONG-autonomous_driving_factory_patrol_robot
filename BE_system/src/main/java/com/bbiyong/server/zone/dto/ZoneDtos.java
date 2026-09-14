package com.bbiyong.server.zone.dto;

import com.bbiyong.server.zone.domain.Zone;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;

/** 구역(Zone) API 요청·응답. (S15P11E101-769) */
public final class ZoneDtos {

    private ZoneDtos() {
    }

    /** 생성/수정 요청. 좌표는 맵 월드 좌표(미터). x1/x2, y1/y2 순서는 서버가 정규화한다. */
    public record ZoneRequest(
            @NotBlank @Size(max = 80) String name,
            @NotNull Double x1,
            @NotNull Double y1,
            @NotNull Double x2,
            @NotNull Double y2
    ) {
    }

    public record ZoneResponse(String id, String name, double x1, double y1, double x2, double y2,
                               Instant createdAt) {

        public static ZoneResponse of(Zone z) {
            return new ZoneResponse(z.getId(), z.getName(), z.getX1(), z.getY1(), z.getX2(), z.getY2(),
                    z.getCreatedAt());
        }

        public static List<ZoneResponse> list(List<Zone> zones) {
            return zones.stream().map(ZoneResponse::of).toList();
        }
    }

    /** 최근접 랜드마크(설비 또는 순찰 웨이포인트). */
    public record Landmark(String type, String id, String name, double distanceM) {
    }

    /**
     * 좌표 → 사람이 읽는 위치 라벨.
     *
     * @param zoneName 좌표를 포함하는 구역명(없으면 null)
     * @param nearest  최근접 랜드마크(설비/웨이포인트 자체가 없으면 null)
     * @param label    표시용 조합 문자열 — 예: "창고 · 분전반 A 근처(1.2m)". 근거가 전혀 없으면 좌표 문자열
     */
    public record ResolveResponse(double x, double y, String zoneId, String zoneName,
                                  Landmark nearest, String label) {
    }
}
