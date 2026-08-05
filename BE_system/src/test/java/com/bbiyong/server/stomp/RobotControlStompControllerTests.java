package com.bbiyong.server.stomp;

import com.bbiyong.server.map.service.MappingStatusService;
import com.bbiyong.server.stomp.dto.ControlCommand;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 제어 중계 컨트롤러가 STOMP 명령을 올바른 로봇 명령 JSON 페이로드로 변환·중계하는지 검증.
 */
class RobotControlStompControllerTests {

    private final RobotWebSocketSessionManager sessionManager = mock(RobotWebSocketSessionManager.class);
    private final MappingStatusService mappingStatusService = mock(MappingStatusService.class);
    private final RobotControlStompController controller =
            new RobotControlStompController(sessionManager, mappingStatusService, -30.0, 45.0);

    @SuppressWarnings("unchecked")
    private Map<String, Object> capturePayload(String expectedRobotId) {
        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(sessionManager).sendCommand(eq(expectedRobotId), captor.capture());
        return captor.getValue();
    }

    @Test
    void driveRelaysDriveCommand() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("DRIVE");
        cmd.setLinear(0.5);
        cmd.setAngular(-0.1);

        controller.drive(cmd);

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("command", "DRIVE")
                .containsEntry("linear", 0.5)
                .containsEntry("angular", -0.1);
    }

    @Test
    void driveDefaultsMissingValuesToZeroAndUsesDefaultRobotId() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("DRIVE"); // robotId 없음, linear/angular 없음

        controller.drive(cmd);

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("linear", 0.0).containsEntry("angular", 0.0);
    }

    @Test
    void modeRelaysValidSetMode() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("SET_MODE");
        cmd.setMode("autonomy");

        controller.mode(cmd);

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("command", "SET_MODE").containsEntry("mode", "autonomy");
    }

    @Test
    void modeDropsInvalidMode() {
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("SET_MODE");
        cmd.setMode("teleport"); // 유효하지 않음

        controller.mode(cmd);

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void estopNoLongerSupported() {
        // 긴급 정지 기능 제거(S15P11E101-681) — ESTOP 은 유효한 mode 가 아니므로 drop 된다.
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("ESTOP");

        controller.mode(cmd);

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void navigateRelaysCoordinates() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("NAVIGATE");
        cmd.setX(15.0);
        cmd.setY(8.2);

        controller.operation(cmd);

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("command", "NAVIGATE")
                .containsEntry("x", 15.0).containsEntry("y", 8.2).containsEntry("yaw", 0.0);
    }

    @Test
    void navigateDroppedWhenMissingCoordinates() {
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("NAVIGATE");
        cmd.setX(1.0); // y 누락

        controller.operation(cmd);

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void startMappingRelaysCommand() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("START_MAPPING");

        controller.operation(cmd);

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("command", "START_MAPPING");
        verify(mappingStatusService).markMapping("orinka_01");
    }

    @Test
    void stopMappingRelaysCommand() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("STOP_MAPPING");

        controller.operation(cmd);

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("command", "STOP_MAPPING");
        verify(mappingStatusService).markIdle("orinka_01");
    }

    @Test
    void cameraRelaysTiltWithinRange() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("CAMERA_TILT");
        cmd.setTilt(20.0);

        controller.camera(cmd);

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("command", "CAMERA_TILT").containsEntry("tilt", 20.0);
    }

    @Test
    void cameraClampsTiltToRange() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("CAMERA_TILT");
        cmd.setTilt(120.0); // 최대 45 초과 → 클램프

        controller.camera(cmd);

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("tilt", 45.0);
    }

    @Test
    void cameraDroppedWhenTiltMissing() {
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("CAMERA_TILT"); // tilt 누락

        controller.camera(cmd);

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void saveMapSanitizesName() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("SAVE_MAP");
        cmd.setName("../../etc/factory_01"); // 경로 조작 시도

        controller.operation(cmd);

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("command", "SAVE_MAP").containsEntry("name", "factory_01");
    }
}
