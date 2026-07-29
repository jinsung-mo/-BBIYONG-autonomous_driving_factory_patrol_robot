package com.bbiyong.server.map;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import com.bbiyong.server.map.dto.MapResponses;
import com.bbiyong.server.map.repository.MapArtifactRepository;
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
import org.springframework.http.ResponseEntity;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 맵 이미지 업로드 -> 저장 -> 최신 조회 -> 이미지 서빙 왕복 검증. (S15P11E101-426)
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "bbiyong.map.storage-dir=${java.io.tmpdir}/bbiyong-test-map-store"
})
@AutoConfigureTestRestTemplate
@DirtiesContext
class MapArchiveTests {

    @Autowired
    private TestRestTemplate restTemplate;

    @Autowired
    private MapArtifactRepository mapRepository;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @BeforeEach
    void auth() {
        String token = jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN");
        restTemplate.getRestTemplate().getInterceptors().add((req, body, exec) -> {
            req.getHeaders().setBearerAuth(token);
            return exec.execute(req, body);
        });
        mapRepository.deleteAllInBatch();
    }

    private MapResponses.RegisterResult upload(byte[] content, String filename) {
        ByteArrayResource fileResource = new ByteArrayResource(content) {
            @Override
            public String getFilename() {
                return filename;
            }
        };
        MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
        form.add("file", fileResource);
        form.add("robotId", "orinka_01");
        form.add("name", "factory_01");
        form.add("widthPx", "800");
        form.add("heightPx", "600");
        form.add("resolution", "0.05");
        form.add("originX", "-10.0");
        form.add("originY", "-8.0");
        form.add("originYaw", "0.0");

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.MULTIPART_FORM_DATA);
        ResponseEntity<MapResponses.RegisterResult> resp = restTemplate.postForEntity(
                "/api/maps/upload", new HttpEntity<>(form, headers), MapResponses.RegisterResult.class);
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return resp.getBody();
    }

    @Test
    void uploadThenLatestAndImage() {
        byte[] content = "FAKE-MAP-PNG-BYTES-0123456789".getBytes();
        MapResponses.RegisterResult registered = upload(content, "map.png");
        assertThat(registered.id()).isNotBlank();

        // 최신 맵 조회: 메타데이터 + 서빙 URL
        ResponseEntity<MapResponses.Detail> latest =
                restTemplate.getForEntity("/api/maps/latest?robotId=orinka_01", MapResponses.Detail.class);
        assertThat(latest.getStatusCode()).isEqualTo(HttpStatus.OK);
        MapResponses.Detail body = latest.getBody();
        assertThat(body.name()).isEqualTo("factory_01");
        assertThat(body.imageUrl()).isEqualTo("/api/maps/" + registered.id() + "/image");
        assertThat(body.resolution()).isEqualTo(0.05);
        assertThat(body.originX()).isEqualTo(-10.0);
        assertThat(body.fileSizeBytes()).isEqualTo((long) content.length);

        // 이미지 서빙: 저장한 바이트 그대로
        ResponseEntity<byte[]> image = restTemplate.getForEntity(body.imageUrl(), byte[].class);
        assertThat(image.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(image.getBody()).isEqualTo(content);
        assertThat(image.getHeaders().getContentType().toString()).startsWith("image/");
    }

    @Test
    void latestMissingReturns404() {
        ResponseEntity<String> resp = restTemplate.getForEntity("/api/maps/latest?robotId=nope", String.class);
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void imageMissingReturns404() {
        ResponseEntity<String> resp = restTemplate.getForEntity("/api/maps/nope/image", String.class);
        assertThat(resp.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }
}
