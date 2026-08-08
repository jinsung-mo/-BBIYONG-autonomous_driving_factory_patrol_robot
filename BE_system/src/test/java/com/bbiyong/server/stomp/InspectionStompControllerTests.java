package com.bbiyong.server.stomp;

import com.bbiyong.server.equipment.service.EquipmentService;
import com.bbiyong.server.stomp.dto.InspectionCommand;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import tools.jackson.databind.ObjectMapper;

import java.security.Principal;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
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
    private final SimpMessagingTemplate messagingTemplate = mock(SimpMessagingTemplate.class);
    private final EquipmentService equipmentService = mock(EquipmentService.class);
    private final InspectionStompController controller =
            new InspectionStompController(sessionManager, messagingTemplate, new ObjectMapper(), equipmentService);

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
    void updateRelaysEnabledAndSequence() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        InspectionCommand c = cmd("UPDATE");
        c.setPointId("pt-1");
        c.setEnabled(false);
        c.setSequence(3);

        controller.inspection(c, admin());

        Map<String, Object> p = capture();
        assertThat(p).containsEntry("command", "UPDATE")
                .containsEntry("pointId", "pt-1")
                .containsEntry("enabled", false)
                .containsEntry("sequence", 3);
    }

    // --- 웹 echo — 다른 접속자·탭이 로봇 회신 없이도 같은 전이를 재현한다 ---

    @Test
    void validCommandIsEchoedToInspectionTopic() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);
        InspectionCommand c = cmd("CONFIRM");
        c.setCandidateId("cand-1");

        controller.inspection(c, admin());

        ArgumentCaptor<String> echo = ArgumentCaptor.forClass(String.class);
        verify(messagingTemplate).convertAndSend(eq("/topic/inspection"), echo.capture());
        assertThat(echo.getValue())
                .contains("\"inspection_point_command\"")
                .contains("\"CONFIRM\"")
                .contains("\"cand-1\"");
    }

    @Test
    void echoHappensEvenWhenRobotOffline() {
        when(sessionManager.sendCommand(any(), any())).thenReturn(false);
        InspectionCommand c = cmd("REJECT");
        c.setCandidateId("cand-2");

        controller.inspection(c, admin());

        // 로봇이 꺼져 있어도 웹 화면들은 먼저 맞춰 둔다 — 로봇 재접속 스냅샷이 최종 진실.
        verify(messagingTemplate).convertAndSend(eq("/topic/inspection"), anyString());
    }

    @Test
    void confirmWithoutCandidateIsDropped() {
        controller.inspection(cmd("CONFIRM"), admin()); // candidateId 없음
        verify(sessionManager, never()).sendCommand(any(), any());
        // 검증에서 떨어진 명령은 echo 도 하지 않는다 — 화면 전이가 로봇 계약보다 앞서면 안 된다.
        verify(messagingTemplate, never()).convertAndSend(anyString(), anyString());
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
