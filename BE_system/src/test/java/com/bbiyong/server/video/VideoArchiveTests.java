package com.bbiyong.server.video;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import com.bbiyong.server.video.dto.VideoResponses;
import com.bbiyong.server.video.repository.VideoClipRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.resttestclient.TestRestTemplate;
import org.springframework.boot.resttestclient.autoconfigure.AutoConfigureTestRestTemplate;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.RequestEntity;
import org.springframework.http.ResponseEntity;
import org.springframework.test.annotation.DirtiesContext;

import java.net.URI;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.datasource.url=jdbc:sqlite:build/test-video.db",
        "spring.jpa.hibernate.ddl-auto=create-drop"
})
@AutoConfigureTestRestTemplate
@DirtiesContext
class VideoArchiveTests {

    @Autowired
    private TestRestTemplate restTemplate;

    @Autowired
    private VideoClipRepository videoClipRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @BeforeEach
    void clean() {
        String token = jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
        restTemplate.getRestTemplate().getInterceptors().add((req, body, exec) -> {
            req.getHeaders().setBearerAuth(token);
            return exec.execute(req, body);
        });
        videoClipRepository.deleteAllInBatch();
    }

    private VideoResponses.RegisterResult register(String body) {
        RequestEntity<String> req = RequestEntity.post(URI.create("/api/videos"))
                .contentType(MediaType.APPLICATION_JSON).body(body);
        ResponseEntity<VideoResponses.RegisterResult> resp = restTemplate.exchange(req, VideoResponses.RegisterResult.class);
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return resp.getBody();
    }

    @Test
    void registerThenListDetailAndByEvent() {
        register("""
                {"robotId":"orinka_01","eventId":1,"clipType":"EVENT","storageType":"FILESYSTEM",
                 "filePath":"/data/videos/evt_1.mp4","thumbnailPath":"/data/videos/evt_1.jpg",
                 "durationSec":30,"fileSizeBytes":5242880,"startedAt":"2026-07-27T10:30:00Z","endedAt":"2026-07-27T10:30:30Z"}
                """);
        VideoResponses.RegisterResult patrol = register("""
                {"robotId":"orinka_01","clipType":"PATROL","storageType":"FILESYSTEM",
                 "filePath":"/data/videos/patrol_1.mp4","startedAt":"2026-07-27T09:00:00Z"}
                """);

        // 전체 목록 (최신순)
        ResponseEntity<VideoResponses.PageResult> all =
                restTemplate.getForEntity("/api/videos", VideoResponses.PageResult.class);
        assertThat(all.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(all.getBody().totalElements()).isEqualTo(2);
        assertThat(all.getBody().content().get(0).clipType()).isEqualTo("EVENT"); // 10:30이 최신

        // clipType 필터
        ResponseEntity<VideoResponses.PageResult> onlyPatrol =
                restTemplate.getForEntity("/api/videos?clipType=PATROL", VideoResponses.PageResult.class);
        assertThat(onlyPatrol.getBody().totalElements()).isEqualTo(1);
        assertThat(onlyPatrol.getBody().content().get(0).id()).isEqualTo(patrol.id());

        // 이벤트별 조회
        ResponseEntity<VideoResponses.Summary[]> byEvent =
                restTemplate.getForEntity("/api/events/1/video", VideoResponses.Summary[].class);
        assertThat(byEvent.getBody()).hasSize(1);
        assertThat(byEvent.getBody()[0].clipType()).isEqualTo("EVENT");
    }

    @Test
    void detailReturnsPlaybackUrl() {
        VideoResponses.RegisterResult r = register("""
                {"robotId":"orinka_01","clipType":"MANUAL","storageType":"FILESYSTEM",
                 "filePath":"/data/videos/man_1.mp4","startedAt":"2026-07-27T11:00:00Z"}
                """);
        ResponseEntity<VideoResponses.Detail> detail =
                restTemplate.getForEntity("/api/videos/" + r.id(), VideoResponses.Detail.class);
        assertThat(detail.getStatusCode().is2xxSuccessful()).isTrue();
        assertThat(detail.getBody().playbackUrl()).isEqualTo("/data/videos/man_1.mp4");
        assertThat(detail.getBody().clipType()).isEqualTo("MANUAL");
    }

    @Test
    void detailNotFoundReturns404() {
        ResponseEntity<String> resp = restTemplate.getForEntity("/api/videos/99999", String.class);
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }
}
