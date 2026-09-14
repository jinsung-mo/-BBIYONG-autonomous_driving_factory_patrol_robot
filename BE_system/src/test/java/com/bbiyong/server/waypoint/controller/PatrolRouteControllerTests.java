package com.bbiyong.server.waypoint.controller;

import com.bbiyong.server.waypoint.dto.RouteRequest;
import com.bbiyong.server.waypoint.dto.WaypointRequest;
import com.bbiyong.server.waypoint.dto.WaypointResponses;
import com.bbiyong.server.waypoint.service.WaypointService;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 경로 중심 퍼사드가 WaypointService(동일 데이터 소스)로 위임하는지 검증.
 */
class PatrolRouteControllerTests {

    private final WaypointService service = mock(WaypointService.class);
    private final PatrolRouteController controller = new PatrolRouteController(service);

    @Test
    void getRouteDelegates() {
        WaypointResponses.Route route = new WaypointResponses.Route("orinka_01", 0, List.of());
        when(service.getRoute("orinka_01")).thenReturn(route);

        ResponseEntity<WaypointResponses.Route> resp = controller.getRoute("orinka_01");

        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(resp.getBody()).isSameAs(route);
    }

    @Test
    void replaceRouteReplacesThenReturnsRoute() {
        RouteRequest req = new RouteRequest(List.of(new WaypointRequest(1.0, 2.0, 0.0, "p0", null)));
        WaypointResponses.Route route = new WaypointResponses.Route("orinka_01", 1, List.of());
        when(service.getRoute(null)).thenReturn(route);

        ResponseEntity<WaypointResponses.Route> resp = controller.replaceRoute(null, req);

        verify(service).replace(eq(null), eq(req.waypoints()));
        assertThat(resp.getBody()).isSameAs(route);
    }

    @Test
    void addPointDelegatesWith201() {
        WaypointRequest req = new WaypointRequest(1.0, 2.0, 0.0, "p", null);
        WaypointResponses.Item item = new WaypointResponses.Item("id", "orinka_01", "p", 1.0, 2.0, 0.0, 0, null);
        when(service.add(null, req)).thenReturn(item);

        ResponseEntity<WaypointResponses.Item> resp = controller.addPoint(null, req);

        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(resp.getBody()).isSameAs(item);
    }

    @Test
    void deletePointDelegates() {
        ResponseEntity<Void> resp = controller.deletePoint("wp-1");
        verify(service).delete("wp-1");
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
    }

    @Test
    void applyDelegates() {
        WaypointResponses.ApplyResult ar = new WaypointResponses.ApplyResult("SUCCESS", true, 2);
        when(service.apply("orinka_01")).thenReturn(ar);

        ResponseEntity<WaypointResponses.ApplyResult> resp = controller.apply("orinka_01");

        assertThat(resp.getBody()).isSameAs(ar);
    }
}
