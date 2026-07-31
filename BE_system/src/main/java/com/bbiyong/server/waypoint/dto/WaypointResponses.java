package com.bbiyong.server.waypoint.dto;

import com.bbiyong.server.waypoint.domain.Waypoint;

import java.util.List;

/**
 * 순찰 지점 응답 DTO 모음.
 */
public final class WaypointResponses {

    private WaypointResponses() {}

    public record Item(String id, String robotId, String name,
                       Double x, Double y, Double yaw, Integer seq, String createdAt) {
        public static Item of(Waypoint w) {
            return new Item(w.getId(), w.getRobotId(), w.getName(),
                    w.getX(), w.getY(), w.getYaw(), w.getSeq(),
                    w.getCreatedAt() != null ? w.getCreatedAt().toString() : null);
        }
    }

    public static List<Item> items(List<Waypoint> list) {
        return list.stream().map(Item::of).toList();
    }

    /** 로봇 경로 하달(apply) 결과. delivered=false 는 로봇 미연결(DB는 저장돼 있음). */
    public record ApplyResult(String status, boolean delivered, int count) {
    }
}
