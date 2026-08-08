package com.bbiyong.server.equipment;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.equipment.service.EquipmentService;
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
import org.springframework.http.ResponseEntity;
import org.springframework.test.annotation.DirtiesContext;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@AutoConfigureTestRestTemplate
@DirtiesContext
class EquipmentTests {

    @Autowired
    private EquipmentRepository equipmentRepository;

    @Autowired
    private EquipmentService equipmentService;

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
    void getEquipmentsReturnsRegisteredEquipment() {
        // 자동 시드를 제거했으므로(S15P11E101) 테스트가 직접 설비를 등록해 조회를 검증한다.
        Equipment probe = new Equipment();
        probe.setEquipmentId("panel_probe");
        probe.setName("조회 검증 분전반");
        probe.setStatus("UNKNOWN");
        equipmentRepository.save(probe);

        ResponseEntity<Equipment[]> resp = restTemplate.getForEntity("/api/equipments", Equipment[].class);
        assertThat(resp.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(resp.getBody()).isNotNull();
        assertThat(resp.getBody()).extracting(Equipment::getEquipmentId)
                .contains("panel_probe");
    }

    @Test
    void purgeRemovesDemoEquipmentButKeepsReal() {
        // 데모 시드/흔적(panel_A/B/C, '데모')은 정리 대상, 실제 로봇 점검 설비는 유지.
        Equipment demoA = new Equipment(); demoA.setEquipmentId("panel_A"); demoA.setName("A구역 분전반"); demoA.setStatus("UNKNOWN");
        Equipment demoNamed = new Equipment(); demoNamed.setEquipmentId("eq_x"); demoNamed.setName("데모"); demoNamed.setStatus("UNKNOWN");
        Equipment real = new Equipment(); real.setEquipmentId("switchboard_101"); real.setName("101호 분전반"); real.setStatus("UNKNOWN");
        equipmentRepository.saveAll(java.util.List.of(demoA, demoNamed, real));

        equipmentService.purgeDemoEquipments();

        assertThat(equipmentRepository.findById("panel_A")).isEmpty();
        assertThat(equipmentRepository.findById("eq_x")).isEmpty();
        assertThat(equipmentRepository.findById("switchboard_101")).isPresent();
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

}
