package com.bbiyong.server.robot.controller;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.socket.WebSocketSession;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
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

	@Autowired
	private RobotWebSocketSessionManager sessionManager;

	@Test
	void getRobotsReturnsRobotSummary() throws Exception {
		String token = jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
		mockMvc.perform(get("/api/robots").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$[0].robotId").value("orinka_01"))
				.andExpect(jsonPath("$[0].status").value("AUTO_PATROL"))
				.andExpect(jsonPath("$[0].battery").value(92.5))
				// WSS 세션이 없으면 offline
				.andExpect(jsonPath("$[0].online").value(false));
	}

	@Test
	void robotShowsOnlineWhenWssSessionOpen() throws Exception {
		WebSocketSession mockSession = mock(WebSocketSession.class);
		when(mockSession.getId()).thenReturn("sess-online-test");
		when(mockSession.isOpen()).thenReturn(true);
		sessionManager.register("orinka_01", mockSession);
		try {
			String token = jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
			mockMvc.perform(get("/api/robots").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
					.andExpect(status().isOk())
					.andExpect(jsonPath("$[0].robotId").value("orinka_01"))
					.andExpect(jsonPath("$[0].online").value(true));
		} finally {
			sessionManager.unregisterBySessionId("sess-online-test");
		}
	}
}
