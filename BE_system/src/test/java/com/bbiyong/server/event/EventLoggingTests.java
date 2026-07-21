package com.bbiyong.server.event;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.repository.EventLogRepository;
import com.bbiyong.server.tcp.dto.RobotPacket;
import com.bbiyong.server.tcp.event.RobotFireEvent;
import com.bbiyong.server.tcp.event.RobotOverheatEvent;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.test.annotation.DirtiesContext;

import java.util.List;

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
        assertThat(fireLog.getX()).isEqualTo(10.0);
        assertThat(fireLog.getY()).isEqualTo(20.0);
        assertThat(fireLog.getTimestamp()).isNotNull();

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
        assertThat(overheatLog.getX()).isEqualTo(30.0);
        assertThat(overheatLog.getY()).isEqualTo(40.0);
        assertThat(overheatLog.getTimestamp()).isNotNull();
    }
}
