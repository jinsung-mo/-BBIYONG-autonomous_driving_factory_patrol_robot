package com.bbiyong.server.tcp.dto;

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
