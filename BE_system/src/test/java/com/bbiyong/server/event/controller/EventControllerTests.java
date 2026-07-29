package com.bbiyong.server.event.controller;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.repository.EventLogRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;

import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.jpa.hibernate.ddl-auto=create-drop"
})
@AutoConfigureTestRestTemplate
@AutoConfigureMockMvc
@DirtiesContext
class EventControllerTests {

    @Autowired
    private EventLogRepository eventLogRepository;

    @Autowired
    private TestRestTemplate restTemplate;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    private String bearer() {
        return "Bearer " + jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
    }

    @BeforeEach
    void seed() {
        String token = jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
        restTemplate.getRestTemplate().getInterceptors().add((req, body, exec) -> {
            req.getHeaders().setBearerAuth(token);
            return exec.execute(req, body);
        });
        eventLogRepository.deleteAll();
        save("OVERHEAT", Instant.parse("2026-07-24T00:00:00Z"));
        save("FIRE", Instant.parse("2026-07-24T00:01:00Z"));
        save("FIRE", Instant.parse("2026-07-24T00:02:00Z"));
    }

    private void save(String type, Instant timestamp) {
        EventLog e = new EventLog();
        e.setType(type);
        e.setRobotId("orinka_01");
        e.setTimestamp(timestamp);
        e.setStatus("UNRESOLVED");
        eventLogRepository.save(e);
    }

    @Test
    void returnsAllEventsNewestFirst() {
        ResponseEntity<EventPageResponse> resp =
                restTemplate.getForEntity("/api/events", EventPageResponse.class);

        assertThat(resp.getStatusCode().is2xxSuccessful()).isTrue();
        EventPageResponse body = resp.getBody();
        assertThat(body).isNotNull();
        assertThat(body.totalElements()).isEqualTo(3);
        // timestamp 내림차순: 가장 최근(00:02, FIRE)이 먼저
        assertThat(body.content().get(0).getType()).isEqualTo("FIRE");
        assertThat(body.content().get(0).getTimestamp()).isEqualTo(Instant.parse("2026-07-24T00:02:00Z"));
    }

    @Test
    void filtersByType() {
        ResponseEntity<EventPageResponse> resp =
                restTemplate.getForEntity("/api/events?type=FIRE", EventPageResponse.class);

        assertThat(resp.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(resp.getBody()).isNotNull();
        assertThat(resp.getBody().totalElements()).isEqualTo(2);
        assertThat(resp.getBody().content()).allMatch(e -> "FIRE".equals(e.getType()));
    }

    @Test
    void paginates() {
        ResponseEntity<EventPageResponse> resp =
                restTemplate.getForEntity("/api/events?page=0&size=1", EventPageResponse.class);

        assertThat(resp.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(resp.getBody()).isNotNull();
        assertThat(resp.getBody().content()).hasSize(1);
        assertThat(resp.getBody().totalPages()).isEqualTo(3);
        assertThat(resp.getBody().totalElements()).isEqualTo(3);
    }

    @Test
    void resolveUpdatesStatus() throws Exception {
        Long id = eventLogRepository.findAll().get(0).getEventId();

        mockMvc.perform(patch("/api/events/{id}", id)
                        .header(HttpHeaders.AUTHORIZATION, bearer())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"RESOLVED\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("RESOLVED"));

        assertThat(eventLogRepository.findById(id).orElseThrow().getStatus()).isEqualTo("RESOLVED");
    }

    @Test
    void resolveMissingEventReturns404() throws Exception {
        mockMvc.perform(patch("/api/events/{id}", 999999L)
                        .header(HttpHeaders.AUTHORIZATION, bearer())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"RESOLVED\"}"))
                .andExpect(status().isNotFound());
    }

    @Test
    void resolveInvalidStatusReturns400() throws Exception {
        Long id = eventLogRepository.findAll().get(0).getEventId();

        mockMvc.perform(patch("/api/events/{id}", id)
                        .header(HttpHeaders.AUTHORIZATION, bearer())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"DONE\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void resolveWithoutTokenReturns401() throws Exception {
        Long id = eventLogRepository.findAll().get(0).getEventId();

        mockMvc.perform(patch("/api/events/{id}", id)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"status\":\"RESOLVED\"}"))
                .andExpect(status().isUnauthorized());
    }
}
