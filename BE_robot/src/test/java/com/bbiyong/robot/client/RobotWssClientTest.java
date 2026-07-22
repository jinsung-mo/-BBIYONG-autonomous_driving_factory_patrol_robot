package com.bbiyong.robot.client;

import com.bbiyong.robot.dto.LocationDto;
import com.bbiyong.robot.dto.RobotTelemetryPacket;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

public class RobotWssClientTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    @DisplayName("로봇 텔레메트리 DTO JSON 직렬화 규격 검증")
    void testTelemetryPacketSerialization() throws Exception {
        RobotTelemetryPacket packet = RobotTelemetryPacket.builder()
                .source("robot")
                .type("TELEMETRY")
                .robotId("orinka_01")
                .location(new LocationDto(12.34, 5.67, 1.57))
                .battery(95.0)
                .status("AUTO_PATROL")
                .timestamp(1781778100L)
                .build();

        String json = objectMapper.writeValueAsString(packet);

        assertThat(json).contains("\"robot_id\":\"orinka_01\"");
        assertThat(json).contains("\"type\":\"TELEMETRY\"");
        assertThat(json).contains("\"battery\":95.0");
    }
}
