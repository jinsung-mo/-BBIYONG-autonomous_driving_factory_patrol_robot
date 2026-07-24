package com.bbiyong.server.wss.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class RobotPacket {
    private String source;
    private String type; // TELEMETRY, EVENT_FIRE, EVENT_OVERHEAT
    
    @JsonProperty("robot_id")
    private String robotId;
    
    private Location location;
    private Double battery;
    private String status; // AUTO_PATROL, MANUAL_CONTROL, DISPATCH, VERIFY
    private Double confidence;
    private Double temperature;

    // 듀얼 카메라 영상 프레임 (VIDEO_FRAME) - S15P11E101-354
    private String channel;   // FRONT(RGB) | THERMAL
    private String format;    // jpeg
    private String data;      // base64-encoded JPEG
    private Double maxTemp;   // THERMAL 채널의 최대 온도(℃)
    private Long seq;         // 프레임 시퀀스

    @JsonProperty("equipment_id")
    private String equipmentId;

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Location {
        private Double x;
        private Double y;
        private Double yaw;
    }
}
