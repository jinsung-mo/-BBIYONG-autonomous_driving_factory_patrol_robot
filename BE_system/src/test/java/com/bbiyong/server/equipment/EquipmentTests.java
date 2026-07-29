package com.bbiyong.server.equipment;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.dto.StatusResponse;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotInspectionEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.RequestEntity;
import org.springframework.http.ResponseEntity;
import org.springframework.test.annotation.DirtiesContext;

import java.net.URI;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureTestRestTemplate
@DirtiesContext
class EquipmentTests {

    @Autowired
    private EquipmentRepository equipmentRepository;

    @Autowired
    private TestRestTemplate restTemplate;

    @Autowired
    private ApplicationEventPublisher eventPublisher;

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
    void getEquipmentsReturnsSeededPanels() {
        ResponseEntity<Equipment[]> resp = restTemplate.getForEntity("/api/equipments", Equipment[].class);
        assertThat(resp.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(resp.getBody()).isNotNull();
        assertThat(resp.getBody()).extracting(Equipment::getEquipmentId)
                .contains("panel_A", "panel_B", "panel_C");
    }

    @Test
    void overheatEventMarksEquipmentOver() {
        RobotPacket p = new RobotPacket();
        p.setType("EVENT_OVERHEAT");
        p.setRobotId("orinka_01");
        p.setEquipmentId("panel_A");
        p.setTemperature(63.2);
        p.setThreshold(55.0);
        p.setThermalImage("BASE64_THERMAL");

        eventPublisher.publishEvent(new RobotOverheatEvent(this, p));

        Equipment e = equipmentRepository.findById("panel_A").orElseThrow();
        assertThat(e.getStatus()).isEqualTo("OVER");
        assertThat(e.getLastTemperature()).isEqualTo(63.2);
        assertThat(e.getThreshold()).isEqualTo(55.0);
        assertThat(e.getLastInspectedAt()).isNotNull();
    }

    @Test
    void inspectionEventMarksEquipmentNormal() {
        RobotPacket p = new RobotPacket();
        p.setType("INSPECTION");
        p.setRobotId("orinka_01");
        p.setEquipmentId("panel_B");
        p.setTemperature(41.5);
        p.setThreshold(55.0);

        eventPublisher.publishEvent(new RobotInspectionEvent(this, p));

        Equipment e = equipmentRepository.findById("panel_B").orElseThrow();
        assertThat(e.getStatus()).isEqualTo("NORMAL");
        assertThat(e.getLastTemperature()).isEqualTo(41.5);
    }

    @Test
    void updateThresholdSuccess() {
        ResponseEntity<StatusResponse> resp = restTemplate.exchange(
                RequestEntity.put(URI.create("/api/equipments/panel_C"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"threshold\": 70.0}"),
                StatusResponse.class);

        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(resp.getBody()).isNotNull();
        assertThat(resp.getBody().status()).isEqualTo("SUCCESS");
        assertThat(equipmentRepository.findById("panel_C").orElseThrow().getThreshold()).isEqualTo(70.0);
    }

    @Test
    void updateThresholdNotFoundReturns404() {
        ResponseEntity<String> resp = restTemplate.exchange(
                RequestEntity.put(URI.create("/api/equipments/panel_ZZZ"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"threshold\": 55.0}"),
                String.class);

        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void updateThresholdInvalidBodyReturns400() {
        ResponseEntity<String> resp = restTemplate.exchange(
                RequestEntity.put(URI.create("/api/equipments/panel_C"))
                        .contentType(MediaType.APPLICATION_JSON)
                        .body("{\"threshold\": -5.0}"),
                String.class);

        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }
}
