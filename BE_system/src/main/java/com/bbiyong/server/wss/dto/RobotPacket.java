package com.bbiyong.server.wss.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class RobotPacket {
    private String source;
    private String type; // REGISTER, TELEMETRY, STATE_UPDATE, VIDEO_FRAME, EVENT_FIRE, EVENT_OVERHEAT, INSPECTION

    // AprilTag 점검 지점(wall-ping) 메시지는 type 대신 kind 를 쓴다: inspection_candidate |
    // inspection_candidates | inspection_point(s) | inspection_point_event. 원문 그대로 관제에 중계. (S15P11E101-778)
    private String kind;

    @JsonProperty("robot_id")
    private String robotId;

    /** 로봇이 재전송에도 유지하는 위험 이벤트 식별자. */
    @JsonProperty("message_id")
    private String messageId;

    private Location location;
    private Double battery;
    // 로봇이 보고하는 상위 FSM 상태 (명령 mode(autonomy/manual/disabled)와는 별개 축)
    private String status; // AUTO_PATROL, APPROACH, VERIFY, MANUAL_CONTROL, MAPPING
    /** 로봇(Jetson)이 발생시킨 시각의 Unix epoch seconds. */
    private Long timestamp;
    private Double confidence;
    private Double temperature;

    // 확장 텔레메트리 필드 (S15P11E101-352 / 명세 S15P11E101-345)
    private String estop;            // RELEASED | ENGAGED
    private Integer commLatencyMs;   // 통신 왕복 지연(ms)
    private Double inferenceFps;     // YOLO 추론 FPS

    // 듀얼 카메라 영상 프레임 (VIDEO_FRAME) - S15P11E101-354
    private String channel;   // FRONT(RGB) | THERMAL
    private String format;    // jpeg
    private String data;      // base64-encoded JPEG
    private Double maxTemp;   // THERMAL 채널의 최대 온도(℃)
    private Long seq;         // 프레임 시퀀스

    @JsonProperty("equipment_id")
    private String equipmentId;

    // 분전반 점검/과열 (EVENT_OVERHEAT / INSPECTION) - S15P11E101-378
    private Double threshold;        // 로봇이 보유한 판정 임계치(℃)
    private String thermalImage;     // 과열 시 열화상 스냅샷 base64 (경보와 함께 중계, 미저장)

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Location {
        private Double x;
        private Double y;
        private Double yaw;
    }
}
