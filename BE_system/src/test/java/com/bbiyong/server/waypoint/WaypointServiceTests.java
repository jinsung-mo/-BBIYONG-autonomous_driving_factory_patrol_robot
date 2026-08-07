package com.bbiyong.server.waypoint;

import com.bbiyong.server.waypoint.domain.Waypoint;
import com.bbiyong.server.waypoint.dto.WaypointRequest;
import com.bbiyong.server.waypoint.dto.WaypointResponses;
import com.bbiyong.server.waypoint.repository.WaypointRepository;
import com.bbiyong.server.waypoint.service.WaypointService;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class WaypointServiceTests {

    private final WaypointRepository repository = mock(WaypointRepository.class);
    private final RobotWebSocketSessionManager sessionManager = mock(RobotWebSocketSessionManager.class);
    private final WaypointService service = new WaypointService(repository, sessionManager);

    private Waypoint wp(String id, double x, double y, int seq) {
        Waypoint w = new Waypoint();
        w.setId(id);
        w.setRobotId("orinka_01");
        w.setX(x);
        w.setY(y);
        w.setSeq(seq);
        return w;
    }

    @Test
    void getRouteReturnsOrderedRoute() {
        when(repository.findByRobotIdOrderBySeqAscCreatedAtAsc("orinka_01"))
                .thenReturn(List.of(wp("a", 1.0, 1.0, 0), wp("b", 2.0, 2.0, 1)));

        WaypointResponses.Route route = service.getRoute(null);

        assertThat(route.robotId()).isEqualTo("orinka_01");
        assertThat(route.count()).isEqualTo(2);
        assertThat(route.waypoints()).hasSize(2);
        assertThat(route.waypoints().get(0).seq()).isEqualTo(0);
    }

    @Test
    void addAssignsNextSeqWhenOmitted() {
        when(repository.findByRobotIdOrderBySeqAscCreatedAtAsc("orinka_01"))
                .thenReturn(List.of(wp("a", 1.0, 1.0, 0), wp("b", 2.0, 2.0, 1)));
        when(repository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        WaypointResponses.Item item = service.add(null, new WaypointRequest(3.0, 4.0, 0.0, "지점3", null));

        assertThat(item.seq()).isEqualTo(2); // max(1)+1
        assertThat(item.x()).isEqualTo(3.0);
        assertThat(item.y()).isEqualTo(4.0);
    }

    @Test
    @SuppressWarnings("unchecked")
    void applyRelaysSetPatrolRouteToRobot() {
        when(repository.findByRobotIdOrderBySeqAscCreatedAtAsc("orinka_01"))
                .thenReturn(List.of(wp("a", 1.0, 1.0, 0), wp("b", 2.5, 3.5, 1)));
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);

        WaypointResponses.ApplyResult result = service.apply("orinka_01");

        assertThat(result.delivered()).isTrue();
        assertThat(result.count()).isEqualTo(2);

        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(sessionManager).sendCommand(eq("orinka_01"), captor.capture());
        Map<String, Object> payload = captor.getValue();
        assertThat(payload).containsEntry("command", "SET_PATROL_ROUTE");
        assertThat((List<?>) payload.get("waypoints")).hasSize(2);
    }

    @Test
    void applyReturnsNotDeliveredWhenRobotOffline() {
        when(repository.findByRobotIdOrderBySeqAscCreatedAtAsc("orinka_01")).thenReturn(List.of());
        when(sessionManager.sendCommand(any(), any())).thenReturn(false);

        WaypointResponses.ApplyResult result = service.apply(null);

        assertThat(result.delivered()).isFalse();
        assertThat(result.count()).isZero();
    }

    @Test
    void deleteMissingReturns404() {
        when(repository.existsById("nope")).thenReturn(false);
        assertThatThrownBy(() -> service.delete("nope"))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void replaceClearsThenSavesInOrder() {
        when(repository.save(any())).thenAnswer(inv -> inv.getArgument(0));

        List<WaypointResponses.Item> out = service.replace("orinka_01", List.of(
                new WaypointRequest(1.0, 1.0, null, "p0", null),
                new WaypointRequest(2.0, 2.0, null, "p1", null)));

        verify(repository).deleteByRobotId("orinka_01");
        assertThat(out).hasSize(2);
        assertThat(out.get(0).seq()).isEqualTo(0);
        assertThat(out.get(1).seq()).isEqualTo(1);
    }

    // --- 로봇 validate_route 정합성 (S15P11E101-620) ---

    @Test
    void replaceRejectsDuplicateSeq() {
        assertThatThrownBy(() -> service.replace("orinka_01", List.of(
                new WaypointRequest(1.0, 1.0, null, "a", 1),
                new WaypointRequest(2.0, 2.0, null, "b", 1))))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void replaceRejectsNonFiniteCoordinate() {
        assertThatThrownBy(() -> service.replace("orinka_01", List.of(
                new WaypointRequest(Double.NaN, 1.0, null, "a", null))))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void replaceRejectsMoreThanMaxWaypoints() {
        List<WaypointRequest> tooMany = new java.util.ArrayList<>();
        for (int i = 0; i < WaypointService.MAX_WAYPOINTS + 1; i++) {
            tooMany.add(new WaypointRequest(0.0, 0.0, null, null, i));
        }
        assertThatThrownBy(() -> service.replace("orinka_01", tooMany))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void replacePreservesNullYawForRobotAutoHeadingAndTruncatesName() {
        when(repository.save(any())).thenAnswer(inv -> inv.getArgument(0));
        String longName = "n".repeat(WaypointService.MAX_NAME_LEN + 50);

        List<WaypointResponses.Item> out = service.replace("orinka_01", List.of(
                new WaypointRequest(1.0, 1.0, null, longName, null)));

        // (2026-08-07) null must stay null, not be forced to 0.0: the robot's
        // patrol_route.py interprets null yaw as "face the nearest structure"
        // and would silently always face map +X if this were normalized away.
        assertThat(out.get(0).yaw()).isNull();
        assertThat(out.get(0).name()).hasSize(WaypointService.MAX_NAME_LEN);
    }

    // --- 순찰 시작(SET_PATROL_ROUTE + SET_MODE autonomy) (S15P11E101-620) ---

    @Test
    @SuppressWarnings("unchecked")
    void startPatrolSendsSetModeAutonomyAfterRoute() {
        when(repository.findByRobotIdOrderBySeqAscCreatedAtAsc("orinka_01"))
                .thenReturn(List.of(wp("a", 1.0, 1.0, 0)));
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);

        WaypointResponses.PatrolStartResult result = service.startPatrol("orinka_01");

        assertThat(result.status()).isEqualTo("SUCCESS");
        assertThat(result.patrolStarted()).isTrue();

        ArgumentCaptor<Map<String, Object>> captor = ArgumentCaptor.forClass(Map.class);
        verify(sessionManager, org.mockito.Mockito.times(2)).sendCommand(eq("orinka_01"), captor.capture());
        List<Map<String, Object>> sent = captor.getAllValues();
        assertThat(sent.get(0)).containsEntry("command", "SET_PATROL_ROUTE");
        assertThat(sent.get(1)).containsEntry("command", "SET_MODE").containsEntry("mode", "autonomy");
    }

    @Test
    void startPatrolSkipsSetModeWhenRouteEmpty() {
        when(repository.findByRobotIdOrderBySeqAscCreatedAtAsc("orinka_01")).thenReturn(List.of());
        when(sessionManager.sendCommand(any(), any())).thenReturn(true);

        WaypointResponses.PatrolStartResult result = service.startPatrol("orinka_01");

        assertThat(result.status()).isEqualTo("NO_ROUTE");
        assertThat(result.patrolStarted()).isFalse();
        // SET_PATROL_ROUTE(apply) 1회만, SET_MODE autonomy 는 보내지 않음
        verify(sessionManager, org.mockito.Mockito.times(1)).sendCommand(any(), any());
    }
}
