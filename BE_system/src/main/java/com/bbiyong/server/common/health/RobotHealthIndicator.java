package com.bbiyong.server.common.health;

import com.bbiyong.server.robot.service.RobotService;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

/**
 * 로봇 연결 상태 Health Indicator
 *
 * <p>Actuator health 엔드포인트에서 로봇 연결 상태를 실시간으로 확인할 수 있습니다.
 * - UP: 1대 이상의 로봇이 연결되어 있음
 * - DOWN: 연결된 로봇이 없음 (운영 상태 아님)
 *
 * <p>접근 경로: GET /actuator/health
 */
@Component
public class RobotHealthIndicator implements HealthIndicator {

    private final RobotService robotService;

    public RobotHealthIndicator(RobotService robotService) {
        this.robotService = robotService;
    }

    @Override
    public Health health() {
        try {
            long connectedCount = robotService.getAllRobots().stream()
                    .filter(robot -> robot.online() != null && robot.online())
                    .count();

            if (connectedCount > 0) {
                return Health.up()
                        .withDetail("connectedRobots", connectedCount)
                        .withDetail("totalRobots", robotService.getAllRobots().size())
                        .withDetail("status", "운영 중")
                        .build();
            } else {
                return Health.down()
                        .withDetail("connectedRobots", 0)
                        .withDetail("totalRobots", robotService.getAllRobots().size())
                        .withDetail("status", "로봇 미연결")
                        .withDetail("message", "관제 시스템에 연결된 로봇이 없습니다")
                        .build();
            }
        } catch (Exception e) {
            return Health.down()
                    .withDetail("error", e.getMessage())
                    .withDetail("status", "로봇 상태 조회 실패")
                    .build();
        }
    }
}
