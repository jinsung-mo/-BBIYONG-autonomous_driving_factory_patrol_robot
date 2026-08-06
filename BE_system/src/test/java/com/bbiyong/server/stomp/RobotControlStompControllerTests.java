package com.bbiyong.server.stomp;

import com.bbiyong.server.map.service.MappingStatusService;
import com.bbiyong.server.stomp.dto.ControlCommand;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import tools.jackson.databind.ObjectMapper;

import java.security.Principal;
import java.util.List;
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
 *
 * <p>인가(ROLE_ADMIN)·점유(lease) 관문을 통과해야 중계되므로, 기본 테스트는 관리자 principal 과
 * 고정 sessionId 를 사용한다.
 */
class RobotControlStompControllerTests {

    private static final String SESSION_A = "session-A";

    private final RobotWebSocketSessionManager sessionManager = mock(RobotWebSocketSessionManager.class);
    private final MappingStatusService mappingStatusService = mock(MappingStatusService.class);
    private final SimpMessagingTemplate messagingTemplate = mock(SimpMessagingTemplate.class);
    private final ControlOwnershipService ownershipService =
            new ControlOwnershipService(sessionManager, messagingTemplate, new ObjectMapper());
    private final RobotControlStompController controller =
            new RobotControlStompController(sessionManager, mappingStatusService, ownershipService, -30.0, 45.0);

    /** 제어 권한이 있는 관리자 principal. */
    private static Principal admin() {
        return new UsernamePasswordAuthenticationToken(
                "admin@bbiyong.io", null, List.of(new SimpleGrantedAuthority("ROLE_ADMIN")));
    }

    /** 제어 권한이 없는 일반 사용자 principal(구 VIEWER 역할에 해당). */
    private static Principal viewer() {
        return new UsernamePasswordAuthenticationToken(
                "viewer@bbiyong.io", null, List.of(new SimpleGrantedAuthority("ROLE_USER")));
    }

    private static SimpMessageHeaderAccessor headers(String sessionId) {
        SimpMessageHeaderAccessor accessor = SimpMessageHeaderAccessor.create();
        accessor.setSessionId(sessionId);
        return accessor;
    }

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

        controller.drive(cmd, admin(), headers(SESSION_A));

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

        controller.drive(cmd, admin(), headers(SESSION_A));

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

        controller.mode(cmd, admin(), headers(SESSION_A));

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("command", "SET_MODE").containsEntry("mode", "autonomy");
    }

    @Test
    void modeDropsInvalidMode() {
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("SET_MODE");
        cmd.setMode("teleport"); // 유효하지 않음

        controller.mode(cmd, admin(), headers(SESSION_A));

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void estopNoLongerSupported() {
        // 긴급 정지 기능 제거(S15P11E101-681) — ESTOP 은 유효한 mode 가 아니므로 drop 된다.
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("ESTOP");

        controller.mode(cmd, admin(), headers(SESSION_A));

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

        controller.operation(cmd, admin(), headers(SESSION_A));

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("command", "NAVIGATE")
                .containsEntry("x", 15.0).containsEntry("y", 8.2).containsEntry("yaw", 0.0);
    }

    @Test
    void navigateDroppedWhenMissingCoordinates() {
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("NAVIGATE");
        cmd.setX(1.0); // y 누락

        controller.operation(cmd, admin(), headers(SESSION_A));

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void startMappingRelaysCommand() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("START_MAPPING");

        controller.operation(cmd, admin(), headers(SESSION_A));

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

        controller.operation(cmd, admin(), headers(SESSION_A));

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

        controller.camera(cmd, admin(), headers(SESSION_A));

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

        controller.camera(cmd, admin(), headers(SESSION_A));

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("tilt", 45.0);
    }

    @Test
    void cameraDroppedWhenTiltMissing() {
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("CAMERA_TILT"); // tilt 누락

        controller.camera(cmd, admin(), headers(SESSION_A));

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void saveMapSanitizesName() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("SAVE_MAP");
        cmd.setName("../../etc/factory_01"); // 경로 조작 시도

        controller.operation(cmd, admin(), headers(SESSION_A));

        Map<String, Object> p = capturePayload("orinka_01");
        assertThat(p).containsEntry("command", "SAVE_MAP").containsEntry("name", "factory_01");
    }

    // ── 인가: ROLE_ADMIN 이 아닌 사용자의 제어 명령은 전부 드롭된다 ─────────────────────

    @Test
    void driveDroppedForNonAdminRole() {
        ControlCommand cmd = new ControlCommand();
        cmd.setRobotId("orinka_01");
        cmd.setCommand("DRIVE");
        cmd.setLinear(0.5);

        controller.drive(cmd, viewer(), headers(SESSION_A));

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void driveDroppedWhenPrincipalMissing() {
        // principal 이 아예 없는 프레임(인터셉터 우회 시도)도 드롭되어야 한다.
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("DRIVE");
        cmd.setLinear(0.5);

        controller.drive(cmd, null, headers(SESSION_A));

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void modeDroppedForNonAdminRole() {
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("SET_MODE");
        cmd.setMode("manual");

        controller.mode(cmd, viewer(), headers(SESSION_A));

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void operationDroppedForNonAdminRole() {
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("START_MAPPING");

        controller.operation(cmd, viewer(), headers(SESSION_A));

        verify(sessionManager, never()).sendCommand(any(), any());
        verify(mappingStatusService, never()).markMapping(any());
    }

    @Test
    void cameraDroppedForNonAdminRole() {
        ControlCommand cmd = new ControlCommand();
        cmd.setCommand("CAMERA_TILT");
        cmd.setTilt(10.0);

        controller.camera(cmd, viewer(), headers(SESSION_A));

        verify(sessionManager, never()).sendCommand(any(), any());
    }

    // ── 점유: 다른 세션이 리스를 들고 있으면 관리자여도 드롭된다 ──────────────────────

    @Test
    void driveDroppedWhenAnotherSessionHoldsLease() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        // 세션 A 가 먼저 점유
        ControlCommand first = new ControlCommand();
        first.setRobotId("orinka_01");
        first.setCommand("DRIVE");
        first.setLinear(0.3);
        controller.drive(first, admin(), headers(SESSION_A));

        // 세션 B(다른 관리자)가 같은 로봇에 명령 → 드롭
        ControlCommand second = new ControlCommand();
        second.setRobotId("orinka_01");
        second.setCommand("DRIVE");
        second.setLinear(-0.9);
        controller.drive(second, admin(), headers("session-B"));

        // A 의 명령 1건만 전달됐다
        verify(sessionManager).sendCommand(eq("orinka_01"), any());
    }

    @Test
    void ownershipTakeoverTransfersLeaseAndForcesStop() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand drive = new ControlCommand();
        drive.setRobotId("orinka_01");
        drive.setCommand("DRIVE");
        drive.setLinear(0.4);
        controller.drive(drive, admin(), headers(SESSION_A));

        ControlCommand takeover = new ControlCommand();
        takeover.setRobotId("orinka_01");
        takeover.setCommand("TAKEOVER");
        controller.ownership(takeover, admin(), headers("session-B"));

        assertThat(ownershipService.isOwner("orinka_01", "session-B")).isTrue();
        // 탈취 순간 정지 프레임이 강제 발행된다
        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(sessionManager, org.mockito.Mockito.times(2)).sendCommand(eq("orinka_01"), captor.capture());
        Map<String, Object> stop = captor.getAllValues().get(1);
        assertThat(stop).containsEntry("command", "DRIVE")
                .containsEntry("linear", 0.0)
                .containsEntry("angular", 0.0);
    }

    @Test
    void ownershipReleaseFreesLease() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        ControlCommand acquire = new ControlCommand();
        acquire.setRobotId("orinka_01");
        acquire.setCommand("ACQUIRE");
        controller.ownership(acquire, admin(), headers(SESSION_A));
        assertThat(ownershipService.isOwner("orinka_01", SESSION_A)).isTrue();

        ControlCommand release = new ControlCommand();
        release.setRobotId("orinka_01");
        release.setCommand("RELEASE");
        controller.ownership(release, admin(), headers(SESSION_A));

        assertThat(ownershipService.current("orinka_01")).isNull();
    }

    @Test
    void ownershipRequestDroppedForNonAdminRole() {
        ControlCommand acquire = new ControlCommand();
        acquire.setRobotId("orinka_01");
        acquire.setCommand("ACQUIRE");

        controller.ownership(acquire, viewer(), headers(SESSION_A));

        assertThat(ownershipService.current("orinka_01")).isNull();
    }
}
