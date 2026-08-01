package com.bbiyong.server.common.health;

import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.messaging.simp.user.SimpUserRegistry;
import org.springframework.stereotype.Component;

/**
 * WebSocket (STOMP) 연결 상태 Health Indicator
 *
 * <p>관제 대시보드와의 STOMP WebSocket 연결 상태를 모니터링합니다.
 * - UP: WebSocket 서비스 정상 동작 중
 * - 연결된 세션 수 표시
 *
 * <p>접근 경로: GET /actuator/health
 */
@Component
public class WebSocketHealthIndicator implements HealthIndicator {

    private final SimpUserRegistry simpUserRegistry;

    public WebSocketHealthIndicator(SimpUserRegistry simpUserRegistry) {
        this.simpUserRegistry = simpUserRegistry;
    }

    @Override
    public Health health() {
        try {
            int activeUsers = simpUserRegistry.getUserCount();

            return Health.up()
                    .withDetail("activeConnections", activeUsers)
                    .withDetail("protocol", "STOMP over WebSocket")
                    .withDetail("endpoints", "/ws-관제, /ws/control")
                    .build();
        } catch (Exception e) {
            return Health.down()
                    .withDetail("error", e.getMessage())
                    .withDetail("status", "WebSocket 서비스 오류")
                    .build();
        }
    }
}
