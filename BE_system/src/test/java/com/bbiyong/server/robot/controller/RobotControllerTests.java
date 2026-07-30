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

	private String adminToken() {
		return jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
	}

	@Test
	void getRobotsEmptyWhenNoRobotConnected() throws Exception {
		// 가짜 프리로드 제거 후: 실제 연결/텔레메트리 없으면 로봇 목록은 비어 있어야 한다.
		mockMvc.perform(get("/api/robots").header(HttpHeaders.AUTHORIZATION, "Bearer " + adminToken()))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$").isArray())
				.andExpect(jsonPath("$.length()").value(0));
	}

	@Test
	void robotShowsOnlineWhenWssSessionOpen() throws Exception {
		WebSocketSession mockSession = mock(WebSocketSession.class);
		when(mockSession.getId()).thenReturn("sess-online-test");
		when(mockSession.isOpen()).thenReturn(true);
		sessionManager.register("orinka_01", mockSession);
		try {
			mockMvc.perform(get("/api/robots").header(HttpHeaders.AUTHORIZATION, "Bearer " + adminToken()))
					.andExpect(status().isOk())
					.andExpect(jsonPath("$[0].robotId").value("orinka_01"))
					.andExpect(jsonPath("$[0].online").value(true))
					// 세션은 열렸지만 텔레메트리 수신 전이므로 status 는 OFFLINE(미확인)
					.andExpect(jsonPath("$[0].status").value("OFFLINE"));
		} finally {
			sessionManager.unregisterBySessionId("sess-online-test");
		}
	}
}
