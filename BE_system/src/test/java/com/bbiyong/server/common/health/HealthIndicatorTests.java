package com.bbiyong.server.common.health;

import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import org.junit.jupiter.api.Test;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.Status;
import org.springframework.messaging.simp.user.SimpUserRegistry;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * robot/webSocket 헬스 컴포넌트의 UP/DOWN 판별과 상세 정보 노출을 검증한다.
 */
class HealthIndicatorTests {

    private final RobotWebSocketSessionManager sessionManager = mock(RobotWebSocketSessionManager.class);
    private final SimpUserRegistry simpUserRegistry = mock(SimpUserRegistry.class);

    @Test
    void robotUpWhenAtLeastOneConnected() {
        when(sessionManager.getConnectedRobotIds()).thenReturn(Set.of("orinka_01"));

        Health health = new RobotHealthIndicator(sessionManager).health();

        assertThat(health.getStatus()).isEqualTo(Status.UP);
        assertThat(health.getDetails().get("connectedRobotCount")).isEqualTo(1);
        assertThat(health.getDetails().get("robotIds")).isEqualTo(Set.of("orinka_01"));
    }

    @Test
    void robotDownWhenNoneConnected() {
        when(sessionManager.getConnectedRobotIds()).thenReturn(Set.of());

        Health health = new RobotHealthIndicator(sessionManager).health();

        assertThat(health.getStatus()).isEqualTo(Status.DOWN);
        assertThat(health.getDetails().get("connectedRobotCount")).isEqualTo(0);
    }

    @Test
    void webSocketAlwaysUpWithSessionCount() {
        when(simpUserRegistry.getUserCount()).thenReturn(3);

        Health health = new WebSocketHealthIndicator(simpUserRegistry).health();

        assertThat(health.getStatus()).isEqualTo(Status.UP);
        assertThat(health.getDetails().get("activeStompUserCount")).isEqualTo(3);
    }

    @Test
    void webSocketUpEvenWithoutSessions() {
        when(simpUserRegistry.getUserCount()).thenReturn(0);

        Health health = new WebSocketHealthIndicator(simpUserRegistry).health();

        assertThat(health.getStatus()).isEqualTo(Status.UP);
    }
}
