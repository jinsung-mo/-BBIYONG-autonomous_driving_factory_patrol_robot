package com.bbiyong.server.robot.dto;

import java.time.Instant;

public record RobotSummary(
		String robotId,
		String name,
		String status,
		double battery,
		Instant lastConnected,
		RobotLocation location
) {
}
