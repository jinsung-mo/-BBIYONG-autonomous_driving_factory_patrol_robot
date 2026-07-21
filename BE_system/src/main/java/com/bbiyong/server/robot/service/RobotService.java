package com.bbiyong.server.robot.service;

import com.bbiyong.server.robot.dto.RobotLocation;
import com.bbiyong.server.robot.dto.RobotSummary;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;

@Service
public class RobotService {

	public List<RobotSummary> getRobots() {
		return List.of(new RobotSummary(
				"orinka_01",
				"순찰로봇 오린카 1호기",
				"AUTO_PATROL",
				92.5,
				Instant.now(),
				new RobotLocation(1.25, 3.40, 0.78)
		));
	}
}
