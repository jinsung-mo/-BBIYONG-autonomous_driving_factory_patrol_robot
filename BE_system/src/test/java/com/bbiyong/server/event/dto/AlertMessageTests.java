package com.bbiyong.server.event.dto;

import com.bbiyong.server.wss.dto.RobotPacket;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;

class AlertMessageTests {

    @Test
    void fireUsesRobotTimestampSimpleMessageAndNullCoordinatesWhenLocationIsAbsent() {
        RobotPacket packet = new RobotPacket();
        packet.setRobotId("orinka_01");
        packet.setConfidence(0.95);
        packet.setTemperature(72.3);
        packet.setTimestamp(1785806400L);

        AlertMessage alert = AlertMessage.fromFire(packet);

        assertThat(alert.message()).isEqualTo("화재 발생");
        assertThat(alert.x()).isNull();
        assertThat(alert.y()).isNull();
        assertThat(alert.timestamp()).isEqualTo(Instant.ofEpochSecond(1785806400L).toString());
    }

    @Test
    void overheatKeepsOptionalThermalFieldsWithSimpleMessage() {
        RobotPacket packet = new RobotPacket();
        packet.setEquipmentId("panel_01");
        packet.setTemperature(85.5);
        packet.setThreshold(55.0);
        packet.setThermalImage("BASE64_THERMAL");
        packet.setTimestamp(1785806401L);

        AlertMessage alert = AlertMessage.fromOverheat(packet);

        assertThat(alert.message()).isEqualTo("과열 발생");
        assertThat(alert.equipmentId()).isEqualTo("panel_01");
        assertThat(alert.temperature()).isEqualTo(85.5);
        assertThat(alert.threshold()).isEqualTo(55.0);
        assertThat(alert.thermalImage()).isEqualTo("BASE64_THERMAL");
    }
}
