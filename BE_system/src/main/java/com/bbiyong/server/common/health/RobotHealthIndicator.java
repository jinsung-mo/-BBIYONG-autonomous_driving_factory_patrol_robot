package com.bbiyong.server.common.health;

import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.stereotype.Component;

import java.util.Set;
import java.util.TreeSet;

/**
 * 로봇 WSS 연결 상태를 /actuator/health 의 {@code robot} 컴포넌트로 노출한다.
 *
 * <p>1대 이상 연결 시 UP, 미연결 시 DOWN — 관제 화면에 로봇이 안 뜰 때
 * "서버 문제 vs 로봇 미접속"을 즉시 분리하기 위한 진단 항목.
 */
@Component("robot")
public class RobotHealthIndicator implements HealthIndicator {

    private final RobotWebSocketSessionManager sessionManager;

    public RobotHealthIndicator(RobotWebSocketSessionManager sessionManager) {
        this.sessionManager = sessionManager;
    }

    @Override
    public Health health() {
        Set<String> robotIds = sessionManager.getConnectedRobotIds();
        Health.Builder builder = robotIds.isEmpty() ? Health.down() : Health.up();
        return builder
                .withDetail("connectedRobotCount", robotIds.size())
                .withDetail("robotIds", new TreeSet<>(robotIds))
                .build();
    }
}
