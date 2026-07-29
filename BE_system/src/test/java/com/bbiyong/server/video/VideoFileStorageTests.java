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
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.RequestEntity;
import org.springframework.http.ResponseEntity;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

import java.net.URI;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 영상 파일 업로드 -> 저장 -> 재생 스트리밍(Range 포함) 왕복 검증. (S15P11E101-412)
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.datasource.url=jdbc:sqlite:file:memdb_vidfile?mode=memory&cache=shared",
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "bbiyong.video.storage-dir=${java.io.tmpdir}/bbiyong-test-video-store"
})
@AutoConfigureTestRestTemplate
@DirtiesContext
class VideoFileStorageTests {

    @Autowired
    private TestRestTemplate restTemplate;

    @Autowired
    private VideoClipRepository videoClipRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @BeforeEach
    void auth() {
        String token = jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
        restTemplate.getRestTemplate().setInterceptors(java.util.List.of((req, body, exec) -> {
            req.getHeaders().setBearerAuth(token);
            return exec.execute(req, body);
        }));
        videoClipRepository.deleteAllInBatch();
    }

    private VideoResponses.RegisterResult upload(byte[] content, String filename) {
        ByteArrayResource fileResource = new ByteArrayResource(content) {
            @Override
            public String getFilename() {
                return filename;
            }
        };
        MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
        form.add("file", fileResource);
        form.add("robotId", "orinka_01");
        form.add("clipType", "PATROL");
        form.add("durationSec", "12");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        ResponseEntity<VideoResponses.RegisterResult> resp = restTemplate.postForEntity(
                "/api/videos/upload", new HttpEntity<>(form, headers), VideoResponses.RegisterResult.class);
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return resp.getBody();
    }

    @Test
    void uploadThenStreamFullAndRange() {
        byte[] content = "FAKE-MP4-CONTENT-0123456789".getBytes();
        VideoResponses.RegisterResult registered = upload(content, "clip.mp4");
        assertThat(registered.id()).isNotBlank();

        // 상세 조회: playbackUrl 이 서빙 API URL 이어야 한다.
        String streamUrl = "/api/videos/" + registered.id() + "/stream";
        ResponseEntity<VideoResponses.Detail> detail =
                restTemplate.getForEntity("/api/videos/" + registered.id(), VideoResponses.Detail.class);
        assertThat(detail.getBody().playbackUrl()).isEqualTo(streamUrl);
        assertThat(detail.getBody().fileSizeBytes()).isEqualTo((long) content.length);

        // Range 미지정: 200 + 전체 바이트 + Accept-Ranges.
        ResponseEntity<byte[]> full = restTemplate.getForEntity(streamUrl, byte[].class);
        assertThat(full.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(full.getBody()).isEqualTo(content);
        assertThat(full.getHeaders().getFirst(HttpHeaders.ACCEPT_RANGES)).isEqualTo("bytes");

        // Range 지정: 206 Partial Content + 해당 구간(0-3, 4바이트).
        HttpHeaders rangeHeaders = new HttpHeaders();
        rangeHeaders.set(HttpHeaders.RANGE, "bytes=0-3");
        ResponseEntity<byte[]> partial = restTemplate.exchange(streamUrl, org.springframework.http.HttpMethod.GET, new HttpEntity<>(rangeHeaders), byte[].class);
        System.out.println("DEBUG PARTIAL STATUS: " + partial.getStatusCode() + ", BODY: " + (partial.getBody() != null ? new String(partial.getBody()) : "null") + ", HEADERS: " + partial.getHeaders());
        assertThat(partial.getStatusCode()).isEqualTo(HttpStatus.PARTIAL_CONTENT);
        assertThat(partial.getBody()).hasSize(4);
        assertThat(partial.getBody()).isEqualTo(new byte[]{content[0], content[1], content[2], content[3]});
    }

    @Test
    void streamMissingClipReturns404() {
        ResponseEntity<String> resp = restTemplate.getForEntity("/api/videos/nope/stream", String.class);
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }
}
