package com.bbiyong.server.robot.dto;

import com.bbiyong.server.robot.domain.Location;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@NoArgsConstructor
@AllArgsConstructor
public class RobotResponse {
    private String robotId;
    private String name;
    private String status;
    private Double battery;
    private Double speed;
    private String estop;
    private Integer commLatencyMs;
    private Double inferenceFps;
    private Instant lastConnected;
    private Location location;
}
