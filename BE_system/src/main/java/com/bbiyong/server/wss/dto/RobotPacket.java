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

    // 순찰/매핑 시작 가능 여부 (S15P11E101-869). 로봇이 2026-08-08 부터 보내고 있었지만
    // 이 클래스에 필드가 없어 **서버에서 통째로 버려지고 있었다** — 위 orinPower 주석이
    // 경고한 그 함정에 그대로 걸린 두 번째 사례다. 그동안 관제의 순찰 시작 버튼 게이트
    // (canStartPatrol)는 값을 한 번도 받지 못한 채 동작하고 있었다.
    private Readiness readiness;

    // 배터리 충전 상태 (S15P11E101-884). 로봇에 충전 감지 센서가 없어 배터리 %의
    // 추세로 추정한 값이다(cloud_bridge.BatteryChargeEstimator).
    // 둘 다 nullable 이고 그 null 에 뜻이 있다:
    //   charging      null = "아직 판단할 표본이 없다"(로봇 기동 후 ≈4분) ≠ false("방전 중")
    //   minutesToFull null = 상승률을 못 구했다(충전 중이 아니거나 상승이 너무 완만)
    // 관제는 두 경우 모두 '—' 로 표시한다. 서버가 임의로 0/false 로 낮추면 안 된다.
    private Boolean charging;
    private Integer minutesToFull;   // 완충까지 남은 시간(분) — 추정치

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

    // 조용한 시스템 로그 (EVENT_SYSTEM). 화재/과열과 **등급이 다른** 경로다:
    // /topic/alerts 로 방송하지 않고 알림도 보내지 않으며, 이벤트 목록에만 남는다.
    //   code    로그 종류. 그대로 이벤트의 type 이 된다 (PLANNER_DOWN, PLANNER_RECOVER_* …).
    //   message 로봇이 만든, 사람이 읽을 문장. 서버·관제가 다시 만들지 않는다.
    // 🔴 위 orinPower·readiness 주석과 같은 함정이다 — 이 두 필드를 여기 선언하지
    //    않으면 로봇이 보내도 @JsonIgnoreProperties(ignoreUnknown = true) 가 조용히 버린다.
    private String code;
    private String message;

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

    /**
     * 순찰/매핑을 지금 시작할 수 있는가 (S15P11E101-869).
     * 로봇 {@code navigation_orchestrator.NavigationOrchestrator.readiness()} 가 만든다.
     *
     * <p>판단을 <b>로봇이 한다</b>는 것이 이 객체의 요점이다. 관제가 매핑 상태·경로 길이·
     * 로컬라이즈 여부를 조합해 추론하면 조건이 하나 늘 때마다 어긋난다. 그래서 서버도
     * 여기서 값을 가공하지 않고 그대로 중계한다.
     *
     * <p>{@code blockedBy} 는 열거형으로 두지 않았다. 로봇이 표에 없는 새 사유를 추가해도
     * (예: ROUTE_SESSION_MISMATCH · NAV_FAILED) 역직렬화가 깨지면 안 되기 때문이다 —
     * 모르는 값이 오면 관제는 {@code hint} 문장을 그대로 보여 준다.
     */
    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Readiness {
        private Boolean canStartPatrol;
        private Boolean canStartMapping;
        /** 차단 사유 코드. 시작 가능하면 null 이다. */
        private String blockedBy;
        /** 로봇이 만든 사용자 문장. 서버·관제가 다시 만들지 않는다. */
        private String hint;
        /** 잠시 뒤 다시 시도해 보라는 권고(초). 없을 수 있다. */
        private Integer retryAfterSec;
    }
}
