package com.bbiyong.server.map.floorplan;

import org.junit.jupiter.api.Test;

import java.awt.image.BufferedImage;

import static org.assertj.core.api.Assertions.assertThat;

class FloorPlanRendererTests {

    private static final int WHITE = 0xFFFFFF;
    private static final int BLACK = 0x000000;

    private boolean isBlack(BufferedImage img, int x, int y) {
        return (img.getRGB(x, y) & 0xFFFFFF) == BLACK;
    }

    @Test
    void keepsWallLineAndRemovesSpeckles() {
        int w = 20, h = 20;
        BufferedImage src = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                src.setRGB(x, y, WHITE);
            }
        }
        // 연결된 벽(세로선, 면적 20)
        for (int y = 0; y < h; y++) {
            src.setRGB(10, y, BLACK);
        }
        // 고립 잡티(단일 픽셀) — 제거 대상
        src.setRGB(3, 3, BLACK);
        src.setRGB(16, 16, BLACK);

        BufferedImage out = new FloorPlanRenderer().render(src);

        assertThat(out.getWidth()).isEqualTo(w);
        assertThat(out.getHeight()).isEqualTo(h);
        // 벽 라인은 유지
        assertThat(isBlack(out, 10, 10)).isTrue();
        // 잡티는 제거되어 흰색
        assertThat(isBlack(out, 3, 3)).isFalse();
        assertThat(isBlack(out, 16, 16)).isFalse();
    }

    @Test
    void treatsUnknownGrayAndFreeAsNonWall() {
        int w = 10, h = 10;
        BufferedImage src = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        // 미탐색(밝은 회색 205)·자유(흰색)만 채움 → 벽 없음
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                src.setRGB(x, y, x < 5 ? 0xCDCDCD : WHITE);
            }
        }
        BufferedImage out = new FloorPlanRenderer().render(src);
        // 벽으로 오분류되지 않아 전부 흰색
        boolean anyBlack = false;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (isBlack(out, x, y)) {
                    anyBlack = true;
                }
            }
        }
        assertThat(anyBlack).isFalse();
    }
}
