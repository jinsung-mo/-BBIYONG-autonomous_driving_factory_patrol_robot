package com.bbiyong.server.robot.controller;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = "spring.datasource.url=jdbc:sqlite:file:memdb_robot?mode=memory&cache=shared")
@AutoConfigureMockMvc
@DirtiesContext
class RobotControllerTests {

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JwtTokenProvider jwtTokenProvider;

	@Test
	void getRobotsReturnsRobotSummary() throws Exception {
		String token = jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
		mockMvc.perform(get("/api/robots").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$[0].robotId").value("orinka_01"))
				.andExpect(jsonPath("$[0].status").value("AUTO_PATROL"))
				.andExpect(jsonPath("$[0].battery").value(92.5));
	}
}
