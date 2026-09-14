package com.bbiyong.server.map.floorplan;

import org.bytedeco.javacpp.BytePointer;
import org.bytedeco.javacpp.indexer.UByteRawIndexer;
import org.bytedeco.opencv.opencv_core.Mat;
import org.springframework.core.io.Resource;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;

import static org.bytedeco.opencv.global.opencv_imgcodecs.IMREAD_GRAYSCALE;
import static org.bytedeco.opencv.global.opencv_imgcodecs.imdecode;

/**
 * 로봇이 업로드한 원본 ROS occupancy-grid PGM(및 구형 PNG/JPEG)을 OpenCV로 디코딩한다. (S15P11E101-616)
 *
 * <p>표준 Java {@link javax.imageio.ImageIO}는 PGM(P5)을 신뢰성 있게 읽지 못해
 * {@code read()}가 {@code null}을 반환할 수 있다. bytedeco OpenCV는 PGM/PNG/JPEG를 모두
 * 디코딩하므로 원본 디코딩 단계를 OpenCV로 대체한다.
 *
 * <p>저장 방식(파일시스템/그 외)에 독립적이도록 파일 경로 기반 {@code imread} 대신
 * 바이트 기반 {@code imdecode}를 사용한다. 디코딩 결과는 그레이스케일 값을 RGB 3채널에
 * 복제한 {@link BufferedImage}(TYPE_INT_RGB)로, {@link FloorPlanRenderer}가 그대로 받는다.
 *
 * <p>네이티브 OpenCV 자원({@link Mat}/{@link BytePointer}/indexer)은 성공·실패 경로 모두에서
 * 결정적으로 해제한다.
 */
public final class RawMapImageDecoder {

    /**
     * 원본 맵 리소스를 그레이스케일로 디코딩한다.
     *
     * @throws IOException 리소스가 비었거나 디코딩 불가(손상/미지원 포맷)한 경우
     */
    public BufferedImage decode(Resource resource) throws IOException {
        byte[] bytes;
        try (InputStream in = resource.getInputStream()) {
            bytes = in.readAllBytes();
        }
        if (bytes.length == 0) {
            throw new IOException("RAW map image is empty");
        }

        BytePointer ptr = new BytePointer(bytes);
        Mat buf = new Mat(ptr);
        Mat gray = null;
        try {
            gray = imdecode(buf, IMREAD_GRAYSCALE);
            if (gray == null || gray.empty()) {
                throw new IOException("RAW map image cannot be decoded");
            }

            int width = gray.cols();
            int height = gray.rows();
            BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);

            UByteRawIndexer pixels = gray.createIndexer();
            try {
                for (int y = 0; y < height; y++) {
                    for (int x = 0; x < width; x++) {
                        int value = pixels.get(y, x) & 0xff;
                        image.setRGB(x, y, (value << 16) | (value << 8) | value);
                    }
                }
            } finally {
                pixels.release();
            }
            return image;
        } finally {
            if (gray != null) {
                gray.release();
            }
            buf.release();
            ptr.deallocate();
        }
    }
}
