package com.bbiyong.server.map.service;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * .pgm 서빙 시 content-type 폴백 검증. (S15P11E101-616)
 *
 * <p>ByteArrayResource 는 getFile() 이 실패(파일 없음)하므로 probeContentType 은 폴백 경로를 탄다.
 * 이때 확장자가 .pgm 이면 image/x-portable-graymap 을, 그 외에는 주어진 fallback 을 반환해야 한다.
 */
class MapStorageContentTypeTests {

    private final MapStorageService storage = new MapStorageService(System.getProperty("java.io.tmpdir"));

    private ByteArrayResource named(String filename) {
        return new ByteArrayResource(new byte[]{1, 2, 3}) {
            @Override
            public String getFilename() {
                return filename;
            }
        };
    }

    @Test
    void pgmFallsBackToPortableGraymap() {
        assertThat(storage.probeContentType(named("map.pgm"), "image/png"))
                .isEqualTo("image/x-portable-graymap");
    }

    @Test
    void nonPgmUsesGivenFallback() {
        assertThat(storage.probeContentType(named("plan.png"), "image/png"))
                .isEqualTo("image/png");
    }
}
