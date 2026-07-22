package com.bbiyong.robot.dto;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class RobotTelemetryPacket {

    @Builder.Default
    private String source = "robot";

    @Builder.Default
    private String type = "TELEMETRY";

    @JsonProperty("robot_id")
    private String robotId;

    private LocationDto location;
    private double battery;
    private String status;
    private long timestamp;
}
