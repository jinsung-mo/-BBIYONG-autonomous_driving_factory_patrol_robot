package com.bbiyong.server.wss.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class RobotPacket {
    private String source;
    private String type; // REGISTER, TELEMETRY, STATE_UPDATE, VIDEO_FRAME, EVENT_FIRE, EVENT_OVERHEAT

    @JsonProperty("robot_id")
    private String robotId;

    private Location location;
    private Double battery;
    // 로봇이 보고하는 상위 FSM 상태 (명령 mode(autonomy/manual/disabled)와는 별개 축)
    private String status; // AUTO_PATROL, APPROACH, VERIFY, MANUAL_CONTROL, MAPPING
    private Double confidence;
    private Double temperature;

    // 확장 텔레메트리 필드 (S15P11E101-352 / 명세 S15P11E101-345)
    private Double speed;            // m/s
    private String estop;            // RELEASED | ENGAGED
    private Integer commLatencyMs;   // 통신 왕복 지연(ms)
    private Double inferenceFps;     // YOLO 추론 FPS
    private Double ambientTemp;      // 주변 온도(℃)
    private Double humidity;         // 습도(%)

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
