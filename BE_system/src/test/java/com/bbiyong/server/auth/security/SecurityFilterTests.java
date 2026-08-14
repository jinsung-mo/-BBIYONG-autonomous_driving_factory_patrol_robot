package com.bbiyong.server.auth.security;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * JWT 인증/인가 필터 동작 검증 (완료 기준).
 */
@SpringBootTest
@AutoConfigureMockMvc
@DirtiesContext
class SecurityFilterTests {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Test
    void protectedEndpointWithoutTokenReturns401() throws Exception {
        mockMvc.perform(get("/api/robots"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.status").value(401))
                .andExpect(jsonPath("$.error").value("Unauthorized"))
                .andExpect(jsonPath("$.path").value("/api/robots"))
                .andExpect(jsonPath("$.timestamp").isNotEmpty());
    }

    @Test
    void protectedEndpointWithValidTokenReturns200() throws Exception {
        String token = jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
        mockMvc.perform(get("/api/robots").header(HttpHeaders.AUTHORIZATION, "Bearer " + token))
                .andExpect(status().isOk());
    }

    @Test
    void protectedEndpointWithInvalidTokenReturns401() throws Exception {
        mockMvc.perform(get("/api/robots").header(HttpHeaders.AUTHORIZATION, "Bearer not-a-valid-token"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.status").value(401));
    }

    @Test
    void authEndpointsArePublic() throws Exception {
        // 토큰 없이도 인증 API 접근 가능 → 401 이 아니라 검증 실패(400)
        mockMvc.perform(post("/api/auth/signup")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"email": "not-an-email", "password": "x", "name": ""}
                                """))
                .andExpect(status().isBadRequest());
    }

    @Test
    void corsPreflightFromLocalhostIsAllowed() throws Exception {
        // 로컬 FE(localhost:5173) 오리진의 프리플라이트가 CORS 허용 헤더로 응답해야 한다.
        mockMvc.perform(options("/api/robots")
                        .header(HttpHeaders.ORIGIN, "http://localhost:5173")
                        .header(HttpHeaders.ACCESS_CONTROL_REQUEST_METHOD, "GET"))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, "http://localhost:5173"));
    }
}
