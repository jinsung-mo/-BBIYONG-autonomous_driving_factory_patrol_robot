package com.bbiyong.server.stomp;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class RobotControlStompControllerTest {
    @Test
    void validates_only_safe_operation_payloads() {
        assertThat(RobotControlStompController.validate("OPERATION", Map.of(
                "command", "SAVE_MAP", "name", "factory_01"))).containsEntry("name", "factory_01");
        assertThat(RobotControlStompController.validate("OPERATION", Map.of(
                "command", "SAVE_MAP", "name", "../escape"))).isNull();
        assertThat(RobotControlStompController.validate("OPERATION", Map.of(
                "command", "NAVIGATE", "x", 1.0, "y", 2.0, "yaw", 0.5))).containsEntry("command", "NAVIGATE");
        assertThat(RobotControlStompController.validate("OPERATION", Map.of(
                "command", "NAVIGATE", "x", Double.NaN, "y", 2.0, "yaw", 0.5))).isNull();
    }

    @Test
    void rejects_untrusted_drive_and_allows_estop_only_as_active() {
        assertThat(RobotControlStompController.validate("DRIVE", Map.of(
                "command", "DRIVE", "linear", 0.1, "angular", -0.2))).containsEntry("command", "DRIVE");
        assertThat(RobotControlStompController.validate("DRIVE", Map.of(
                "command", "DRIVE", "linear", "fast", "angular", 0.0))).isNull();
        assertThat(RobotControlStompController.validate("MODE", Map.of(
                "command", "ESTOP", "active", false))).containsEntry("active", true);
    }
}
