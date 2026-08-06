package com.bbiyong.server.map.floorplan;

import org.bytedeco.javacpp.indexer.DoubleRawIndexer;
import org.bytedeco.javacpp.indexer.IntRawIndexer;
import org.bytedeco.javacpp.indexer.UByteRawIndexer;
import org.bytedeco.opencv.opencv_core.Mat;
import org.bytedeco.opencv.opencv_core.MatVector;
import org.bytedeco.opencv.opencv_core.Point2f;
import org.bytedeco.opencv.opencv_core.RotatedRect;
import org.bytedeco.opencv.opencv_core.Scalar;
import org.bytedeco.opencv.opencv_core.Size;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.List;

import static org.bytedeco.opencv.global.opencv_core.CV_32SC2;
import static org.bytedeco.opencv.global.opencv_core.CV_8UC1;
import static org.bytedeco.opencv.global.opencv_core.bitwise_and;
import static org.bytedeco.opencv.global.opencv_core.subtract;
import static org.bytedeco.opencv.global.opencv_imgproc.CC_STAT_AREA;
import static org.bytedeco.opencv.global.opencv_imgproc.CHAIN_APPROX_SIMPLE;
import static org.bytedeco.opencv.global.opencv_imgproc.GaussianBlur;
import static org.bytedeco.opencv.global.opencv_imgproc.INTER_CUBIC;
import static org.bytedeco.opencv.global.opencv_imgproc.MORPH_CLOSE;
import static org.bytedeco.opencv.global.opencv_imgproc.MORPH_ELLIPSE;
import static org.bytedeco.opencv.global.opencv_imgproc.MORPH_OPEN;
import static org.bytedeco.opencv.global.opencv_imgproc.RETR_EXTERNAL;
import static org.bytedeco.opencv.global.opencv_imgproc.THRESH_BINARY;
import static org.bytedeco.opencv.global.opencv_imgproc.THRESH_BINARY_INV;
import static org.bytedeco.opencv.global.opencv_imgproc.approxPolyDP;
import static org.bytedeco.opencv.global.opencv_imgproc.connectedComponentsWithStats;
import static org.bytedeco.opencv.global.opencv_imgproc.contourArea;
import static org.bytedeco.opencv.global.opencv_imgproc.dilate;
import static org.bytedeco.opencv.global.opencv_imgproc.drawContours;
import static org.bytedeco.opencv.global.opencv_imgproc.erode;
import static org.bytedeco.opencv.global.opencv_imgproc.findContours;
import static org.bytedeco.opencv.global.opencv_imgproc.getRotationMatrix2D;
import static org.bytedeco.opencv.global.opencv_imgproc.getStructuringElement;
import static org.bytedeco.opencv.global.opencv_imgproc.minAreaRect;
import static org.bytedeco.opencv.global.opencv_imgproc.morphologyEx;
import static org.bytedeco.opencv.global.opencv_imgproc.resize;
import static org.bytedeco.opencv.global.opencv_imgproc.threshold;
import static org.bytedeco.opencv.global.opencv_imgproc.warpAffine;

/**
 * SLAM 점유격자(원본 PGM)를 관제용 2D 도면으로 정제한다. (S15P11E101-518, 640)
 *
 * <p>실제 로봇 PGM(저해상도 점유격자)으로 검증한 파이프라인:
 * <ol>
 *   <li>자유공간(free) 마스크 → 업스케일(CUBIC) → 최대 연결요소만 채택</li>
 *   <li>deskew: 방의 지배적 벽 방향(minAreaRect)으로 수평 정렬(패딩 캔버스, 잘림 없음)</li>
 *   <li>approxPolyDP 직선화 + 직각 스냅(수평/수직 ±tol) → 도면 느낌의 반듯한 벽</li>
 *   <li>벽 = 채운 방의 형태학적 경계(dilate−erode) → 방향 무관 균일 두께, 스파이크 실선 없음</li>
 *   <li>내부 장애물 = occupied ∩ 내부(침식) → open 정제·최소면적 필터 → 직각 스냅 후 검정</li>
 * </ol>
 *
 * <p>출력 좌표계가 원본과 달라지므로(스케일·회전·패딩) {@link Result#rawToOut()} 아핀 변환을
 * 함께 반환한다 — {@link FloorPlanGeometry#transformMeta} 로 도면의 resolution/origin 을
 * 재계산해 FE 픽셀↔월드 변환 정합을 유지한다.
 */
@Component
public final class FloorPlanRenderer {

    // 도면 인코딩 색상: 벽=검정, 내부 장애물=중회색, 배경=흰색. FE 표시색과 무관한 데이터 계약이며
    // MapGridService 가 이 명도대로 벽(1)/장애물(2)/자유(0)를 분류한다. (S15P11E101-776)
    private static final int BG_RGB = 0xFFFFFF;
    private static final int WALL_RGB = 0x000000;
    private static final int OBSTACLE_RGB = 0x808080;

    private final int scale;
    private final int freeThreshold;
    private final int wallThreshold;
    private final double polyEpsilon;
    private final double orthoTolDeg;
    private final int wallBand;
    private final int obstacleInset;
    private final long obstacleMinArea;
    private final boolean deskew;

    /**
     * 도면 렌더 결과.
     *
     * @param image         도면 이미지(흰 배경·검은 벽/장애물)
     * @param deskewDegrees 적용된 수평 보정 각도(도). deskew 비활성/미적용 시 0
     * @param rawToOut      원본 픽셀 → 도면 픽셀 아핀 변환 [a,b,c,d,e,f]:
     *                      x' = a·x + b·y + c, y' = d·x + e·y + f
     */
    public record Result(BufferedImage image, double deskewDegrees, double[] rawToOut) {
    }

    public FloorPlanRenderer(
            @Value("${bbiyong.floorplan.scale:10}") int scale,
            @Value("${bbiyong.floorplan.free-threshold:210}") int freeThreshold,
            @Value("${bbiyong.floorplan.wall-threshold:100}") int wallThreshold,
            @Value("${bbiyong.floorplan.poly-epsilon:10.0}") double polyEpsilon,
            @Value("${bbiyong.floorplan.ortho-tolerance-deg:25.0}") double orthoTolDeg,
            @Value("${bbiyong.floorplan.wall-band:14}") int wallBand,
            @Value("${bbiyong.floorplan.obstacle-inset:12}") int obstacleInset,
            @Value("${bbiyong.floorplan.obstacle-min-area:250}") long obstacleMinArea,
            @Value("${bbiyong.floorplan.deskew:true}") boolean deskew) {
        this.scale = Math.max(1, scale);
        this.freeThreshold = freeThreshold;
        this.wallThreshold = wallThreshold;
        this.polyEpsilon = polyEpsilon;
        this.orthoTolDeg = orthoTolDeg;
        this.wallBand = Math.max(2, wallBand);
        this.obstacleInset = Math.max(0, obstacleInset);
        this.obstacleMinArea = Math.max(0, obstacleMinArea);
        this.deskew = deskew;
    }

    /** 기본 파라미터(실 PGM 검증값). */
    public FloorPlanRenderer() {
        this(10, 210, 100, 10.0, 25.0, 14, 12, 250, true);
    }

    /** 하위호환: 이미지만 필요한 호출부용. */
    public BufferedImage render(BufferedImage src) {
        return renderPlan(src).image();
    }

    public Result renderPlan(BufferedImage src) {
        int w = src.getWidth();
        int h = src.getHeight();
        int W = w * scale;
        int H = h * scale;

        Mat gray = toGray(src);

        // 1) free 마스크 → 업스케일 → 최대 연결요소
        Mat free = new Mat();
        threshold(gray, free, freeThreshold, 255, THRESH_BINARY);
        Mat room = new Mat();
        resize(free, room, new Size(W, H), 0, 0, INTER_CUBIC);
        GaussianBlur(room, room, new Size(7, 7), 0);
        threshold(room, room, 128, 255, THRESH_BINARY);
        free.release();
        if (!keepLargest(room)) {
            // 자유공간이 전혀 없는 격자(테스트/빈 맵) → 빈 흰 도면 + 항등 변환
            gray.release();
            room.release();
            return blank(w, h);
        }
        Mat kClose = getStructuringElement(MORPH_ELLIPSE, new Size(9, 9));
        morphologyEx(room, room, MORPH_CLOSE, kClose);
        kClose.release();

        // occupied(벽·장애물) 고해상 마스크
        Mat occ = new Mat();
        threshold(gray, occ, wallThreshold, 255, THRESH_BINARY_INV);
        Mat occHi = new Mat();
        resize(occ, occHi, new Size(W, H), 0, 0, INTER_CUBIC);
        threshold(occHi, occHi, 128, 255, THRESH_BINARY);
        occ.release();
        gray.release();

        // 2) deskew(수평 보정) + 패딩. 변환 행렬은 rawToOut 합성에 사용.
        double angle = 0.0;
        int pad = 0;
        double m00 = 1, m01 = 0, m02 = 0, m10 = 0, m11 = 1, m12 = 0;
        if (deskew) {
            MatVector rc = new MatVector();
            findContours(room, rc, RETR_EXTERNAL, CHAIN_APPROX_SIMPLE);
            long ri = 0, rn = -1;
            for (long i = 0; i < rc.size(); i++) {
                if (rc.get(i).total() > rn) {
                    rn = rc.get(i).total();
                    ri = i;
                }
            }
            RotatedRect rect = minAreaRect(rc.get(ri));
            angle = rect.angle();
            if (angle > 45) {
                angle -= 90;
            }
            if (angle < -45) {
                angle += 90;
            }
            pad = (int) (0.10 * Math.min(W, H));
            Mat rot = getRotationMatrix2D(new Point2f(W / 2f, H / 2f), angle, 1.0);
            DoubleRawIndexer rd = rot.createIndexer();
            m00 = rd.get(0, 0);
            m01 = rd.get(0, 1);
            m02 = rd.get(0, 2) + pad;
            m10 = rd.get(1, 0);
            m11 = rd.get(1, 1);
            m12 = rd.get(1, 2) + pad;
            rd.release();
            int W2 = W + pad * 2;
            int H2 = H + pad * 2;
            Mat rot2 = rot.clone();
            DoubleRawIndexer r2 = rot2.createIndexer();
            r2.put(0, 2, m02);
            r2.put(1, 2, m12);
            r2.release();
            Mat room2 = new Mat();
            Mat occ2 = new Mat();
            warpAffine(room, room2, rot2, new Size(W2, H2));
            warpAffine(occHi, occ2, rot2, new Size(W2, H2));
            room.release();
            occHi.release();
            room = room2;
            occHi = occ2;
            threshold(room, room, 128, 255, THRESH_BINARY);
            threshold(occHi, occHi, 128, 255, THRESH_BINARY);
            rot.release();
            rot2.release();
            W = W2;
            H = H2;
        }

        // 3) 경계 직선화 + 직각 스냅 → 채운 방(solid)
        MatVector contours = new MatVector();
        findContours(room, contours, RETR_EXTERNAL, CHAIN_APPROX_SIMPLE);
        if (contours.size() == 0) {
            room.release();
            occHi.release();
            return blank(w, h);
        }
        long bestIdx = 0, bestN = -1;
        for (long i = 0; i < contours.size(); i++) {
            if (contours.get(i).total() > bestN) {
                bestN = contours.get(i).total();
                bestIdx = i;
            }
        }
        Mat approx = new Mat();
        approxPolyDP(contours.get(bestIdx), approx, polyEpsilon, true);
        Mat poly = orthoSnap(approx);
        approx.release();
        Mat solid = new Mat(H, W, CV_8UC1, new Scalar(0));
        drawContours(solid, new MatVector(poly), -1, new Scalar(255), -1, 8, new Mat(), Integer.MAX_VALUE, null);
        poly.release();
        room.release();

        // 스냅이 만든 1px 스파이크 팔 제거(유령 실선·두께 불균일 방지)
        Mat kOpen = getStructuringElement(MORPH_ELLIPSE, new Size(7, 7));
        morphologyEx(solid, solid, MORPH_OPEN, kOpen);
        kOpen.release();
        keepLargest(solid);

        // 4) 벽 = 원형 커널 경계 밴드(방향 무관 균일 두께)
        int half = wallBand / 2;
        Mat kBand = getStructuringElement(MORPH_ELLIPSE, new Size(half * 2 + 1, half * 2 + 1));
        Mat grown = new Mat();
        Mat shrunk = new Mat();
        dilate(solid, grown, kBand);
        erode(solid, shrunk, kBand);
        Mat wall = new Mat();
        subtract(grown, shrunk, wall);
        kBand.release();
        grown.release();
        shrunk.release();

        // 5) 내부 장애물(벽 요철 배제: 침식 + open, 최소면적, 직각 스냅)
        Mat obstOut = new Mat(H, W, CV_8UC1, new Scalar(0));
        Mat inner = new Mat();
        erode(solid, inner, getStructuringElement(MORPH_ELLIPSE,
                new Size(obstacleInset * 2 + 1, obstacleInset * 2 + 1)));
        Mat obst = new Mat();
        bitwise_and(occHi, inner, obst);
        Mat k7 = getStructuringElement(MORPH_ELLIPSE, new Size(7, 7));
        morphologyEx(obst, obst, MORPH_CLOSE, k7);
        morphologyEx(obst, obst, MORPH_OPEN, k7);
        k7.release();
        MatVector oc = new MatVector();
        findContours(obst, oc, RETR_EXTERNAL, CHAIN_APPROX_SIMPLE);
        for (long i = 0; i < oc.size(); i++) {
            Mat c = oc.get(i);
            if (Math.abs(contourArea(c)) < obstacleMinArea) {
                continue;
            }
            Mat oa = new Mat();
            approxPolyDP(c, oa, 8.0, true);
            Mat os = orthoSnap(oa);
            drawContours(obstOut, new MatVector(os), -1, new Scalar(255), -1, 8, new Mat(), Integer.MAX_VALUE, null);
            oa.release();
            os.release();
        }
        inner.release();
        obst.release();
        occHi.release();

        // 6) 렌더: 흰 배경 / 검은 벽 / 중회색 장애물. 장애물을 벽 뒤에 칠해 벽이 우선(경계 겹침 시).
        BufferedImage out = new BufferedImage(W, H, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                out.setRGB(x, y, BG_RGB);
            }
        }
        paint(out, obstOut, OBSTACLE_RGB);
        paint(out, wall, WALL_RGB);
        wall.release();
        obstOut.release();
        solid.release();

        // 원본픽셀→도면픽셀: hi = scale·raw + off(픽셀중심 정렬), out = M·hi (+pad 은 M 에 포함)
        double off = (scale - 1) / 2.0;
        double[] t = new double[]{
                m00 * scale, m01 * scale, m00 * off + m01 * off + m02,
                m10 * scale, m11 * scale, m10 * off + m11 * off + m12,
        };
        return new Result(out, angle, t);
    }

    private Result blank(int w, int h) {
        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                out.setRGB(x, y, BG_RGB);
            }
        }
        return new Result(out, 0.0, new double[]{1, 0, 0, 0, 1, 0});
    }

    private Mat toGray(BufferedImage src) {
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
                int v = a > 10 ? (r * 299 + g * 587 + b * 114) / 1000 : 255;
                gi.put(y, x, v);
            }
        }
        gi.release();
        return gray;
    }

    /** 최대 연결요소만 남긴다. 요소가 없으면 false. */
    private boolean keepLargest(Mat mask) {
        Mat labels = new Mat();
        Mat stats = new Mat();
        Mat cent = new Mat();
        int n = connectedComponentsWithStats(mask, labels, stats, cent);
        if (n <= 1) {
            labels.release();
            stats.release();
            cent.release();
            return false;
        }
        int best = -1;
        long ba = -1;
        IntRawIndexer si = stats.createIndexer();
        for (int lab = 1; lab < n; lab++) {
            long a = si.get(lab, CC_STAT_AREA);
            if (a > ba) {
                ba = a;
                best = lab;
            }
        }
        si.release();
        IntRawIndexer li = labels.createIndexer();
        UByteRawIndexer mi = mask.createIndexer();
        for (long y = 0; y < mask.rows(); y++) {
            for (long x = 0; x < mask.cols(); x++) {
                mi.put(y, x, li.get(y, x) == best ? 255 : 0);
            }
        }
        li.release();
        mi.release();
        labels.release();
        stats.release();
        cent.release();
        return true;
    }

    /**
     * 직각 스냅: 변의 기울기가 수평/수직에서 tol(도) 이내면 축에 정렬(90도 코너),
     * 대각 변은 유지. 스냅으로 생긴 중복/일직선 꼭짓점은 정리한다.
     */
    private Mat orthoSnap(Mat polyIn) {
        int n = (int) polyIn.total();
        int[] xs = new int[n];
        int[] ys = new int[n];
        IntRawIndexer pi = polyIn.createIndexer();
        for (int i = 0; i < n; i++) {
            xs[i] = pi.get(i, 0, 0);
            ys[i] = pi.get(i, 0, 1);
        }
        pi.release();

        for (int i = 0; i < n; i++) {
            int j = (i + 1) % n;
            int dx = xs[j] - xs[i];
            int dy = ys[j] - ys[i];
            if (dx == 0 && dy == 0) {
                continue;
            }
            double ang = Math.toDegrees(Math.atan2(Math.abs(dy), Math.abs(dx)));
            if (ang <= orthoTolDeg) {
                ys[j] = ys[i];
            } else if (ang >= 90 - orthoTolDeg) {
                xs[j] = xs[i];
            }
        }

        List<int[]> pts = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            int prev = (i - 1 + n) % n;
            int next = (i + 1) % n;
            boolean dup = xs[i] == xs[next] && ys[i] == ys[next];
            boolean collinear = (xs[prev] == xs[i] && xs[i] == xs[next])
                    || (ys[prev] == ys[i] && ys[i] == ys[next]);
            if (!dup && !collinear) {
                pts.add(new int[]{xs[i], ys[i]});
            }
        }
        if (pts.size() < 3) {
            pts = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                pts.add(new int[]{xs[i], ys[i]});
            }
        }

        Mat out = new Mat(pts.size(), 1, CV_32SC2);
        IntRawIndexer oi = out.createIndexer();
        for (int i = 0; i < pts.size(); i++) {
            oi.put(i, 0, 0, pts.get(i)[0]);
            oi.put(i, 0, 1, pts.get(i)[1]);
        }
        oi.release();
        return out;
    }

    private void paint(BufferedImage img, Mat mask, int rgb) {
        UByteRawIndexer mi = mask.createIndexer();
        int W = mask.cols();
        int H = mask.rows();
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                if ((mi.get(y, x) & 0xff) > 127) {
                    img.setRGB(x, y, rgb);
                }
            }
        }
        mi.release();
    }
}
