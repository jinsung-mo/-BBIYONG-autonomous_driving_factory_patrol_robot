package com.bbiyong.server.map.floorplan;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * RAW PGM(및 구형 PNG) OpenCV 디코딩 검증. (S15P11E101-616)
 */
class RawMapImageDecoderTests {

    private final RawMapImageDecoder decoder = new RawMapImageDecoder();

    /** 헤더 "P5\n2 2\n255\n" + 픽셀 00 40 80 FF → 2x2 그레이스케일 0/64/128/255. */
    private byte[] p5Fixture() throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write("P5\n2 2\n255\n".getBytes(StandardCharsets.US_ASCII));
        out.write(new byte[]{0x00, 0x40, (byte) 0x80, (byte) 0xFF});
        return out.toByteArray();
    }

    private int gray(BufferedImage img, int x, int y) {
        return img.getRGB(x, y) & 0xff;
    }

    @Test
    void decodesBinaryP5PgmWithExactValues() throws Exception {
        BufferedImage img = decoder.decode(new ByteArrayResource(p5Fixture()));

        assertThat(img.getWidth()).isEqualTo(2);
        assertThat(img.getHeight()).isEqualTo(2);
        // 기대 매트릭스:  0   64
        //               128  255
        assertThat(gray(img, 0, 0)).isEqualTo(0);
        assertThat(gray(img, 1, 0)).isEqualTo(64);
        assertThat(gray(img, 0, 1)).isEqualTo(128);
        assertThat(gray(img, 1, 1)).isEqualTo(255);
        // 그레이스케일이 RGB 3채널에 동일 복제되었는지
        int argb = img.getRGB(1, 1);
        assertThat((argb >> 16) & 0xff).isEqualTo(255);
        assertThat((argb >> 8) & 0xff).isEqualTo(255);
        assertThat(argb & 0xff).isEqualTo(255);
    }

    @Test
    void rejectsEmptyFile() {
        assertThatThrownBy(() -> decoder.decode(new ByteArrayResource(new byte[0])))
                .isInstanceOf(IOException.class);
    }

    @Test
    void rejectsMalformedPgm() {
        byte[] garbage = "P5 this is not a valid pgm stream".getBytes(StandardCharsets.US_ASCII);
        assertThatThrownBy(() -> decoder.decode(new ByteArrayResource(garbage)))
                .isInstanceOf(IOException.class);
    }

    @Test
    void decodesLegacyPngForBackwardCompatibility() throws Exception {
        BufferedImage png = new BufferedImage(4, 3, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < 3; y++) {
            for (int x = 0; x < 4; x++) {
                png.setRGB(x, y, 0xFFFFFF);
            }
        }
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ImageIO.write(png, "png", baos);

        BufferedImage decoded = decoder.decode(new ByteArrayResource(baos.toByteArray()));
        assertThat(decoded.getWidth()).isEqualTo(4);
        assertThat(decoded.getHeight()).isEqualTo(3);
        assertThat(gray(decoded, 0, 0)).isEqualTo(255);
    }
}
