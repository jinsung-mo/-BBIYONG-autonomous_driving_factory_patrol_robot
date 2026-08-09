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

    // Orin 부하·전력 (S15P11E101-814).
    // 🔴 이 클래스에 필드가 없으면 로봇이 보내도 값이 사라진다 — 클래스 선언의
    // @JsonIgnoreProperties(ignoreUnknown = true) 가 모르는 필드를 조용히 버리고,
    // 관제로 나가는 payload 는 이 객체를 그대로 직렬화한 것이기 때문이다
    // (RobotEventListener.handleTelemetryEvent). 그래서 "로봇만 고치면 되는" 일이 아니다.
    private OrinPower orinPower;

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

    /**
     * Orin 모듈의 부하·전력 (S15P11E101-814). 로봇의 tegrastats 한 줄에서 나온다.
     *
     * <p>세 값 모두 nullable 이다. 로봇은 못 읽은 값을 넣지 않고 통째로 생략하며,
     * 관제도 값이 없으면 그래프를 그리지 않고 '—' 로 둔다 — 없는 수치를 그리면
     * 조작자가 그것을 믿는다.
     *
     * <p>cpuCores 는 평균이 아니라 <b>코어별 원값</b>이다. 평균을 서버에서 미리 내면
     * 코어 편중(한 코어만 77%, 나머지 40%대)이 사라져 관제가 판단할 근거를 잃는다.
     */
    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class OrinPower {
        private java.util.List<Double> cpuCores;  // 코어별 사용률 %(꺼진 코어는 빠진다)
        private Double gpuPercent;                // GR3D_FREQ %
        private Integer vddInMw;                  // 모듈 전체 입력 전력 mW (peak 25,000)
    }
}
