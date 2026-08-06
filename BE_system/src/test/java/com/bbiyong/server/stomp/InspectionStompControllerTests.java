package com.bbiyong.server.stomp;

import com.bbiyong.server.stomp.dto.InspectionCommand;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

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
 * 점검 지점 명령 중계: 스키마 변환·인자 검증·ROLE_ADMIN 인가 검증. (S15P11E101-778)
 */
class InspectionStompControllerTests {

    private final RobotWebSocketSessionManager sessionManager = mock(RobotWebSocketSessionManager.class);
    private final InspectionStompController controller = new InspectionStompController(sessionManager);

    private static Principal admin() {
        return new UsernamePasswordAuthenticationToken(
                "admin@bbiyong.io", null, List.of(new SimpleGrantedAuthority("ROLE_ADMIN")));
    }

    private static Principal viewer() {
        return new UsernamePasswordAuthenticationToken(
                "viewer@bbiyong.io", null, List.of(new SimpleGrantedAuthority("ROLE_USER")));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> capture() {
        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(sessionManager).sendCommand(eq("orinka_01"), captor.capture());
        return captor.getValue();
    }

    private static InspectionCommand cmd(String command) {
        InspectionCommand c = new InspectionCommand();
        c.setCommand(command);
        return c;
    }

    @Test
    void confirmRelaysWithSchemaAndCandidateAndName() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        InspectionCommand c = cmd("CONFIRM");
        c.setCandidateId("tag-active-map-17");
        c.setName("Panel A");

        controller.inspection(c, admin());

        Map<String, Object> p = capture();
        assertThat(p).containsEntry("schemaVersion", 1)
                .containsEntry("kind", "inspection_point_command")
                .containsEntry("command", "CONFIRM")
                .containsEntry("candidateId", "tag-active-map-17")
                .containsEntry("name", "Panel A");
    }

    @Test
    void deleteRelaysWithPointId() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        InspectionCommand c = cmd("DELETE");
        c.setPointId("3f2a");

        controller.inspection(c, admin());

        Map<String, Object> p = capture();
        assertThat(p).containsEntry("command", "DELETE").containsEntry("pointId", "3f2a");
        assertThat(p).doesNotContainKey("candidateId");
    }

    @Test
    void publishRelaysWithoutArgs() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);

        controller.inspection(cmd("PUBLISH"), admin());

        Map<String, Object> p = capture();
        assertThat(p).containsEntry("command", "PUBLISH");
        assertThat(p).doesNotContainKey("candidateId").doesNotContainKey("pointId");
    }

    @Test
    void confirmWithoutCandidateIsDropped() {
        controller.inspection(cmd("CONFIRM"), admin()); // candidateId 없음
        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void unknownCommandIsDropped() {
        controller.inspection(cmd("NUKE"), admin());
        verify(sessionManager, never()).sendCommand(any(), any());
    }

    @Test
    void nonAdminIsDropped() {
        InspectionCommand c = cmd("CONFIRM");
        c.setCandidateId("tag-1");
        controller.inspection(c, viewer());
        verify(sessionManager, never()).sendCommand(any(), any());
    }
}
