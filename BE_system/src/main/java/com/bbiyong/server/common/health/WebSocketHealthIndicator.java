package com.bbiyong.server.common.health;

import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.messaging.simp.user.SimpUserRegistry;
import org.springframework.stereotype.Component;

/**
 * 관제(STOMP) 활성 세션 수를 /actuator/health 의 {@code webSocket} 컴포넌트로 노출한다.
 *
 * <p>접속자가 없는 것은 정상 운영 상태이므로 항상 UP — 세션 수는 상세 정보로만 제공한다.
 */
@Component("webSocket")
public class WebSocketHealthIndicator implements HealthIndicator {

    private final SimpUserRegistry simpUserRegistry;

    public WebSocketHealthIndicator(SimpUserRegistry simpUserRegistry) {
        this.simpUserRegistry = simpUserRegistry;
    }

    @Override
    public Health health() {
        return Health.up()
                .withDetail("activeStompUserCount", simpUserRegistry.getUserCount())
                .build();
    }
}
