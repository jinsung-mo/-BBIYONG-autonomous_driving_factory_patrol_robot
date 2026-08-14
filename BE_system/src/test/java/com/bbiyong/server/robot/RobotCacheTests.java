package com.bbiyong.server.robot;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import com.bbiyong.server.robot.dto.RobotResponse;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotDisconnectedEvent;
import com.bbiyong.server.wss.event.RobotTelemetryEvent;
import org.junit.jupiter.api.BeforeEach;
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

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @BeforeEach
    void authenticate() {
        String token = jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
        restTemplate.getRestTemplate().getInterceptors().add((req, body, exec) -> {
            req.getHeaders().setBearerAuth(token);
            return exec.execute(req, body);
        });
    }

    @Test
    public void testTelemetryEventUpdatesCacheAndExposesViaApi() {
        // Arrange: prepare a telemetry packet
        RobotPacket packet = new RobotPacket();
        packet.setRobotId("orinka_01");
        packet.setType("TELEMETRY");
        packet.setStatus("AUTO_PATROL");
        packet.setBattery(85.5);
        packet.setEstop("RELEASED");
        packet.setCommLatencyMs(43);
        packet.setInferenceFps(8.0);

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
        // 확장 텔레메트리 필드 노출 검증 (S15P11E101-352, speed 는 681 에서 제거)
        assertThat(targetRobot.getEstop()).isEqualTo("RELEASED");
        assertThat(targetRobot.getCommLatencyMs()).isEqualTo(43);
        assertThat(targetRobot.getInferenceFps()).isEqualTo(8.0);
    }

    @Test
    public void testDisconnectMarksRobotOffline() {
        // 먼저 텔레메트리로 로봇을 등록(온라인 상태처럼)
        RobotPacket packet = new RobotPacket();
        packet.setRobotId("orinka_02");
        packet.setType("TELEMETRY");
        packet.setStatus("AUTO_PATROL");
        packet.setBattery(80.0);
        eventPublisher.publishEvent(new RobotTelemetryEvent(this, packet));

        // 세션 종료(disconnect) 이벤트 발행 → 상태가 OFFLINE 으로 낮아져야 함
        eventPublisher.publishEvent(new RobotDisconnectedEvent(this, "orinka_02"));

        ResponseEntity<RobotResponse[]> response = restTemplate.getForEntity("/api/robots", RobotResponse[].class);
        RobotResponse target = null;
        for (RobotResponse r : response.getBody()) {
            if ("orinka_02".equals(r.getRobotId())) {
                target = r;
                break;
            }
        }
        assertThat(target).isNotNull();
        assertThat(target.getStatus()).isEqualTo("OFFLINE");
        assertThat(target.getOnline()).isFalse();
    }
}
