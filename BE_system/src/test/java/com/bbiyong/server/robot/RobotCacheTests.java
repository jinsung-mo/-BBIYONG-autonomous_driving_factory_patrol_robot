package com.bbiyong.server.robot;

import com.bbiyong.server.robot.dto.RobotResponse;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotTelemetryEvent;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.ResponseEntity;

import org.springframework.test.annotation.DirtiesContext;
import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureTestRestTemplate
@DirtiesContext
public class RobotCacheTests {

    @Autowired
    private ApplicationEventPublisher eventPublisher;

    @Autowired
    private TestRestTemplate restTemplate;

    @Test
    public void testTelemetryEventUpdatesCacheAndExposesViaApi() {
        // Arrange: prepare a telemetry packet
        RobotPacket packet = new RobotPacket();
        packet.setRobotId("orinka_01");
        packet.setType("TELEMETRY");
        packet.setStatus("AUTO_PATROL");
        packet.setBattery(85.5);
        
        RobotPacket.Location location = new RobotPacket.Location();
        location.setX(10.5);
        location.setY(20.5);
        location.setYaw(0.0);
        packet.setLocation(location);

        // Act: publish telemetry event
        eventPublisher.publishEvent(new RobotTelemetryEvent(this, packet));

        // Assert: query REST API GET /api/robots
        ResponseEntity<RobotResponse[]> response = restTemplate.getForEntity("/api/robots", RobotResponse[].class);
        
        assertThat(response.getStatusCode().is2xxSuccessful()).isTrue();
        RobotResponse[] robots = response.getBody();
        assertThat(robots).isNotNull();
        
        // Check if our pre-populated robot got updated
        RobotResponse targetRobot = null;
        for (RobotResponse r : robots) {
            if ("orinka_01".equals(r.getRobotId())) {
                targetRobot = r;
                break;
            }
        }
        
        assertThat(targetRobot).isNotNull();
        assertThat(targetRobot.getStatus()).isEqualTo("AUTO_PATROL");
        assertThat(targetRobot.getBattery()).isEqualTo(85.5);
        assertThat(targetRobot.getLastConnected()).isNotNull();
        assertThat(targetRobot.getLocation().getX()).isEqualTo(10.5);
        assertThat(targetRobot.getLocation().getY()).isEqualTo(20.5);
    }
}
