package com.bbiyong.server.robot.controller;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = "spring.datasource.url=jdbc:sqlite:build/test.db")
@AutoConfigureMockMvc
class RobotControllerTests {

	@Autowired
	private MockMvc mockMvc;

	@Test
	void getRobotsReturnsRobotSummary() throws Exception {
		mockMvc.perform(get("/api/robots"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$[0].robotId").value("orinka_01"))
				.andExpect(jsonPath("$[0].status").value("AUTO_PATROL"))
				.andExpect(jsonPath("$[0].battery").value(92.5));
	}
}
