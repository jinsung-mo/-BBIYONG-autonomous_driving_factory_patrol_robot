package com.bbiyong.server.event;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.test.annotation.DirtiesContext;

import java.util.List;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@DirtiesContext
public class EventLoggingTests {

    @Autowired
    private ApplicationEventPublisher eventPublisher;

    @Autowired
    private EventLogRepository eventLogRepository;

    @Test
    public void testFireAndOverheatEventsArePersistedToDatabase() {
        // Clear database first
        eventLogRepository.deleteAll();

        // 1. Arrange & Act: Publish Fire Event
        RobotPacket firePacket = new RobotPacket();
        firePacket.setRobotId("orinka_01");
        firePacket.setType("EVENT_FIRE");
        firePacket.setConfidence(0.95);
        firePacket.setTemperature(65.0);
        firePacket.setTimestamp(1785806400L);
        
        RobotPacket.Location fireLoc = new RobotPacket.Location();
        fireLoc.setX(10.0);
        fireLoc.setY(20.0);
        fireLoc.setYaw(0.0);
        firePacket.setLocation(fireLoc);

        eventPublisher.publishEvent(new RobotFireEvent(this, firePacket));

        // 2. Arrange & Act: Publish Overheat Event
        RobotPacket overheatPacket = new RobotPacket();
        overheatPacket.setRobotId("orinka_01");
        overheatPacket.setType("EVENT_OVERHEAT");
        overheatPacket.setTemperature(85.5);
        overheatPacket.setTimestamp(1785806401L);
        overheatPacket.setEquipmentId("panel_01");
        overheatPacket.setThreshold(55.0);

        RobotPacket.Location overheatLoc = new RobotPacket.Location();
        overheatLoc.setX(30.0);
        overheatLoc.setY(40.0);
        overheatLoc.setYaw(1.5);
        overheatPacket.setLocation(overheatLoc);

        eventPublisher.publishEvent(new RobotOverheatEvent(this, overheatPacket));

        // 3. Assert: Verify database contents
        List<EventLog> logs = eventLogRepository.findAll();
        assertThat(logs).hasSize(2);

        // Verify Fire Log details
        EventLog fireLog = logs.stream()
                .filter(log -> "FIRE".equals(log.getType()))
                .findFirst()
                .orElse(null);
        assertThat(fireLog).isNotNull();
        assertThat(fireLog.getRobotId()).isEqualTo("orinka_01");
        assertThat(fireLog.getConfidence()).isEqualTo(0.95);
        assertThat(fireLog.getTemperature()).isEqualTo(65.0);
        assertThat(fireLog.getStatus()).isEqualTo("UNRESOLVED");
        assertThat(fireLog.getX()).isZero();
        assertThat(fireLog.getY()).isZero();
        assertThat(fireLog.getTimestamp()).isEqualTo(Instant.ofEpochSecond(1785806400L));
        // 강화 필드: 화재는 CRITICAL, 메시지 보존, 설비 정보 없음
        assertThat(fireLog.getLevel()).isEqualTo("CRITICAL");
        assertThat(fireLog.getMessage()).isEqualTo("화재 발생");
        assertThat(fireLog.getEquipmentId()).isNull();

        // Verify Overheat Log details
        EventLog overheatLog = logs.stream()
                .filter(log -> "OVERHEAT".equals(log.getType()))
                .findFirst()
                .orElse(null);
        assertThat(overheatLog).isNotNull();
        assertThat(overheatLog.getRobotId()).isEqualTo("orinka_01");
        assertThat(overheatLog.getConfidence()).isNull();
        assertThat(overheatLog.getTemperature()).isEqualTo(85.5);
        assertThat(overheatLog.getStatus()).isEqualTo("UNRESOLVED");
        assertThat(overheatLog.getX()).isZero();
        assertThat(overheatLog.getY()).isZero();
        assertThat(overheatLog.getTimestamp()).isEqualTo(Instant.ofEpochSecond(1785806401L));
        // 강화 필드: 과열은 WARNING, 어느 설비인지·임계치·메시지 보존
        assertThat(overheatLog.getLevel()).isEqualTo("WARNING");
        assertThat(overheatLog.getEquipmentId()).isEqualTo("panel_01");
        assertThat(overheatLog.getThreshold()).isEqualTo(55.0);
        assertThat(overheatLog.getMessage()).isEqualTo("과열 발생");
    }
}
