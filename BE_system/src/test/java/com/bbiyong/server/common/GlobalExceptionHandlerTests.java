package com.bbiyong.server.common;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:sqlite:file:memdb_err?mode=memory&cache=shared",
        "spring.jpa.hibernate.ddl-auto=create-drop"
})
@AutoConfigureMockMvc
class GlobalExceptionHandlerTests {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void validationFailureReturnsUnifiedErrorFormat() throws Exception {
        // 잘못된 이메일 + 짧은 비밀번호 + 빈 이름 → 검증 실패(400)
        mockMvc.perform(post("/api/auth/signup")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"email": "not-an-email", "password": "x", "name": ""}
                                """))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.status").value(400))
                .andExpect(jsonPath("$.error").value("Bad Request"))
                .andExpect(jsonPath("$.path").value("/api/auth/signup"))
                .andExpect(jsonPath("$.timestamp").isNotEmpty())
                .andExpect(jsonPath("$.message").isNotEmpty());
    }

    @Test
    void unauthorizedLoginReturnsUnifiedErrorFormat() throws Exception {
        mockMvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"email": "nobody@bbiyong.io", "password": "whatever"}
                                """))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.status").value(401))
                .andExpect(jsonPath("$.error").value("Unauthorized"))
                .andExpect(jsonPath("$.path").value("/api/auth/login"))
                .andExpect(jsonPath("$.timestamp").isNotEmpty());
    }

    @Test
    void wrongMethodReturns405NotWrapped500() throws Exception {
        // POST 전용 로그인 엔드포인트에 GET → 405 (기존엔 500으로 래핑되던 케이스)
        mockMvc.perform(get("/api/auth/login"))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(jsonPath("$.status").value(405))
                .andExpect(jsonPath("$.error").value("Method Not Allowed"))
                .andExpect(jsonPath("$.path").value("/api/auth/login"));
    }

    @Test
    void unsupportedMediaTypeReturns415() throws Exception {
        mockMvc.perform(post("/api/auth/login")
                        .contentType(MediaType.TEXT_PLAIN)
                        .content("not-json"))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.status").value(415))
                .andExpect(jsonPath("$.error").value("Unsupported Media Type"));
    }
}
