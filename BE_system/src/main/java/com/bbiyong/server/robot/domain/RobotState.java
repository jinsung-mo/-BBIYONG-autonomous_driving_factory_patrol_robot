package com.bbiyong.server.robot.domain;

import lombok.Data;
import java.time.Instant;

@Data
public class RobotState {
    private String robotId;
    private String name;
    private String status;
    private Double battery;
    private Double speed;
    private String estop;
    private Integer commLatencyMs;
    private Double inferenceFps;
    private Double ambientTemp;
    private Double humidity;
    private Instant lastConnected;
    private Location location;
}
