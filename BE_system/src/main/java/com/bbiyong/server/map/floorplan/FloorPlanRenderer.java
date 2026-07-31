package com.bbiyong.server.map.floorplan;

import org.bytedeco.javacpp.indexer.IntRawIndexer;
import org.bytedeco.javacpp.indexer.UByteRawIndexer;
import org.bytedeco.opencv.opencv_core.Mat;
import org.bytedeco.opencv.opencv_core.Size;

import java.awt.image.BufferedImage;

import static org.bytedeco.opencv.global.opencv_core.CV_8UC1;
import static org.bytedeco.opencv.global.opencv_core.bitwise_not;
import static org.bytedeco.opencv.global.opencv_imgproc.CC_STAT_AREA;
import static org.bytedeco.opencv.global.opencv_imgproc.MORPH_CLOSE;
import static org.bytedeco.opencv.global.opencv_imgproc.MORPH_RECT;
import static org.bytedeco.opencv.global.opencv_imgproc.THRESH_BINARY_INV;
import static org.bytedeco.opencv.global.opencv_imgproc.connectedComponentsWithStats;
import static org.bytedeco.opencv.global.opencv_imgproc.getStructuringElement;
import static org.bytedeco.opencv.global.opencv_imgproc.morphologyEx;
import static org.bytedeco.opencv.global.opencv_imgproc.threshold;

/**
 * SLAM 점유격자(원본)를 OpenCV로 정제해 직관적인 2D 도면(흑백)으로 변환한다. (S15P11E101-518)
 *
 * <p>파이프라인(bytedeco OpenCV, 인프로세스):
 * <ol>
 *   <li>벽 마스크: threshold(BINARY_INV) 로 어두운(occupied) 픽셀 = 벽(255).</li>
 *   <li>잡티 제거: connectedComponentsWithStats 로 작은 면적 컴포넌트 삭제(가는 벽은 보존).</li>
 *   <li>morphology close: 벽 끊김 메움 후 재정제.</li>
 *   <li>출력: bitwise_not 로 흰 배경·검은 벽의 깔끔한 도면.</li>
 * </ol>
 */
public final class FloorPlanRenderer {

    private final int wallThreshold; // 그레이스케일이 이 값 미만이면 벽(occupied)
    private final int minWallBlob;   // 이보다 작은 벽 연결요소는 잡티로 제거(px)

    public FloorPlanRenderer() {
        this(100, 6);
    }

    public FloorPlanRenderer(int wallThreshold, int minWallBlob) {
        this.wallThreshold = wallThreshold;
        this.minWallBlob = minWallBlob;
    }

    public BufferedImage render(BufferedImage src) {
        int w = src.getWidth();
        int h = src.getHeight();

        Mat gray = new Mat(h, w, CV_8UC1);
        UByteRawIndexer gi = gray.createIndexer();
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int argb = src.getRGB(x, y);
                int a = (argb >>> 24) & 0xff;
                int r = (argb >> 16) & 0xff;
                int g = (argb >> 8) & 0xff;
                int b = argb & 0xff;
                // 투명 픽셀은 자유공간(255)으로 간주
                int v = a > 10 ? (r * 299 + g * 587 + b * 114) / 1000 : 255;
                gi.put(y, x, v);
            }
        }
        gi.release();

        Mat mask = new Mat();
        threshold(gray, mask, wallThreshold, 255, THRESH_BINARY_INV);

        removeSmallComponents(mask, minWallBlob);
        Mat kernel = getStructuringElement(MORPH_RECT, new Size(3, 3));
        morphologyEx(mask, mask, MORPH_CLOSE, kernel);
        removeSmallComponents(mask, minWallBlob);

        Mat outMat = new Mat();
        bitwise_not(mask, outMat); // 벽(255)->0(검정), 배경(0)->255(흰색)

        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        UByteRawIndexer oi = outMat.createIndexer();
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int v = oi.get(y, x) & 0xff;
                out.setRGB(x, y, (v << 16) | (v << 8) | v);
            }
        }
        oi.release();

        gray.release();
        mask.release();
        kernel.release();
        outMat.release();
        return out;
    }

    /** minArea 미만인 벽 연결요소를 제거한다(가는 벽은 보존, 스캔 잡티 삭제). */
    private void removeSmallComponents(Mat mask, int minArea) {
        Mat labels = new Mat();
        Mat stats = new Mat();
        Mat centroids = new Mat();
        int n = connectedComponentsWithStats(mask, labels, stats, centroids);
        try {
            if (n <= 1) {
                return;
            }
            boolean[] keep = new boolean[n];
            IntRawIndexer si = stats.createIndexer();
            for (int lab = 1; lab < n; lab++) {
                keep[lab] = si.get(lab, CC_STAT_AREA) >= minArea;
            }
            si.release();

            IntRawIndexer li = labels.createIndexer();
            UByteRawIndexer mi = mask.createIndexer();
            long rows = mask.rows();
            long cols = mask.cols();
            for (long y = 0; y < rows; y++) {
                for (long x = 0; x < cols; x++) {
                    int lab = li.get(y, x);
                    if (lab > 0 && !keep[lab]) {
                        mi.put(y, x, 0);
                    }
                }
            }
            li.release();
            mi.release();
        } finally {
            labels.release();
            stats.release();
            centroids.release();
        }
    }
}
