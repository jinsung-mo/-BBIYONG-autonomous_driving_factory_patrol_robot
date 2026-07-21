package com.bbiyong.server.robot.controller;

import com.bbiyong.server.robot.dto.RobotSummary;
import com.bbiyong.server.robot.service.RobotService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/robots")
public class RobotController {

	private final RobotService robotService;

	public RobotController(RobotService robotService) {
		this.robotService = robotService;
	}

	@GetMapping
	public ResponseEntity<List<RobotSummary>> getRobots() {
		return ResponseEntity.ok(robotService.getRobots());
	}
}
