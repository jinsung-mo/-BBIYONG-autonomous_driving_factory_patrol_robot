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
public class RobotFireEventPacket {

    @Builder.Default
    private String source = "robot";

    @Builder.Default
    private String type = "EVENT_FIRE";

    @JsonProperty("robot_id")
    private String robotId;

    private double confidence;
    private double temperature;
    private LocationDto location;
    private long timestamp;
}
