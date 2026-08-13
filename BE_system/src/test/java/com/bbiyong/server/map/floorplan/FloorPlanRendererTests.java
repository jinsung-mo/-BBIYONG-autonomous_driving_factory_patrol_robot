package com.bbiyong.server.map.floorplan;

import org.junit.jupiter.api.Test;

import java.awt.image.BufferedImage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * 도면 후처리 파이프라인 검증(합성 점유격자). (S15P11E101-518, 640)
 */
class FloorPlanRendererTests {

    private static final int UNKNOWN = 0xCDCDCD; // 205 미탐색
    private static final int FREE = 0xFEFEFE;    // 254 자유공간
    private static final int WALL = 0x000000;    // 0 벽/장애물

    /** 60x40 합성 맵: 미탐색 배경 + 방(직사각형 free) + 2px 벽 프레임 + 내부 장애물. */
    private BufferedImage syntheticMap() {
        int w = 60, h = 40;
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                img.setRGB(x, y, UNKNOWN);
            }
        }
        for (int y = 8; y <= 32; y++) {          // 방 내부 free
            for (int x = 10; x <= 50; x++) {
                img.setRGB(x, y, FREE);
            }
        }
        for (int x = 8; x <= 52; x++) {          // 벽 프레임(상하)
            for (int y : new int[]{6, 7, 33, 34}) {
                img.setRGB(x, y, WALL);
            }
        }
        for (int y = 6; y <= 34; y++) {          // 벽 프레임(좌우)
            for (int x : new int[]{8, 9, 51, 52}) {
                img.setRGB(x, y, WALL);
            }
        }
        for (int y = 16; y <= 24; y++) {         // 내부 장애물(기둥)
            for (int x = 26; x <= 32; x++) {
                img.setRGB(x, y, WALL);
            }
        }
        return img;
    }

    private boolean isBlack(BufferedImage img, int x, int y) {
        return (img.getRGB(x, y) & 0xFFFFFF) == 0x000000;
    }

    private boolean isObstacleGray(BufferedImage img, int x, int y) {
        return (img.getRGB(x, y) & 0xFFFFFF) == 0x808080;   // S15P11E101-776 장애물 색
    }

    /** 원본 픽셀 좌표를 rawToOut 아핀으로 도면 픽셀로 변환. */
    private int[] toOut(double[] t, double x, double y) {
        return new int[]{
                (int) Math.round(t[0] * x + t[1] * y + t[2]),
                (int) Math.round(t[3] * x + t[4] * y + t[5]),
        };
    }

    @Test
    void rendersWallBandObstacleAndFreeInterior() {
        FloorPlanRenderer.Result r = new FloorPlanRenderer().renderPlan(syntheticMap());
        BufferedImage out = r.image();
        double[] t = r.rawToOut();

        // 축 정렬 합성 맵 → deskew 각도는 0 근처
        assertThat(Math.abs(r.deskewDegrees())).isLessThan(3.0);

        // 방 내부(장애물에서 떨어진 지점)는 흰색(벽/장애물 아님)
        int[] interior = toOut(t, 18, 20);
        assertThat(isBlack(out, interior[0], interior[1])).isFalse();
        assertThat(isObstacleGray(out, interior[0], interior[1])).isFalse();

        // 내부 장애물 중심은 중회색(벽과 구분, S15P11E101-776)
        int[] pillar = toOut(t, 29, 20);
        assertThat(isObstacleGray(out, pillar[0], pillar[1])).isTrue();

        // 벽 프레임 위치는 검정(경계 밴드)
        int[] wallTop = toOut(t, 30, 7);
        assertThat(isBlack(out, wallTop[0], wallTop[1])).isTrue();

        // 방에서 먼 바깥(미탐색)은 흰 배경
        int[] outside = toOut(t, 2, 2);
        assertThat(isBlack(out, outside[0], outside[1])).isFalse();
    }

    /**
     * 오목한 장애물(L자·ㄴ)의 형상을 보존한다 — 패인 부분을 직사각형으로 덮지 않는다. (S15P11E101)
     * SLAM 은 로봇이 본 표면만 occupied 로 찍지만, 장애물 주위를 돌며 스캔하면 셸이 닫혀 실제
     * 형상이 들어온다. 종전 minAreaRect 강제 채움은 L 의 오목부까지 사각형으로 뭉갰다 — 이제
     * 관측 윤곽을 그대로 채워 팔(arm)은 솔리드로, 오목 노치는 배경으로 남긴다.
     */
    @Test
    void preservesConcaveLShapedObstacle() {
        int w = 60, h = 40;
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) img.setRGB(x, y, UNKNOWN);
        }
        for (int y = 8; y <= 32; y++) {          // 방 내부 free
            for (int x = 10; x <= 50; x++) img.setRGB(x, y, FREE);
        }
        for (int x = 8; x <= 52; x++) for (int y : new int[]{6, 7, 33, 34}) img.setRGB(x, y, WALL);
        for (int y = 6; y <= 34; y++) for (int x : new int[]{8, 9, 51, 52}) img.setRGB(x, y, WALL);

        // L자(ㄴ): 왼쪽 세로 팔 + 아래 가로 팔. 오른쪽 위(노치)는 free 로 남긴다.
        for (int y = 14; y <= 26; y++) for (int x = 24; x <= 28; x++) img.setRGB(x, y, WALL); // 세로 팔
        for (int y = 22; y <= 26; y++) for (int x = 24; x <= 38; x++) img.setRGB(x, y, WALL); // 가로 팔

        FloorPlanRenderer.Result r = new FloorPlanRenderer().renderPlan(img);
        BufferedImage out = r.image();
        double[] t = r.rawToOut();

        // 세로 팔·가로 팔 내부는 솔리드로 채워져 중회색
        int[] vArm = toOut(t, 26, 20);
        assertThat(isObstacleGray(out, vArm[0], vArm[1])).isTrue();
        int[] hArm = toOut(t, 34, 24);
        assertThat(isObstacleGray(out, hArm[0], hArm[1])).isTrue();

        // 🔴 오목 노치(오른쪽 위)는 장애물이 아니어야 한다 — minAreaRect 였다면 여기까지 사각형이
        //    덮었다. 형상 보존이 되면 배경(중회색 아님)으로 남는다.
        int[] notch = toOut(t, 34, 17);
        assertThat(isObstacleGray(out, notch[0], notch[1])).isFalse();
    }

    @Test
    void metaTransformKeepsWorldCoordinatesConsistent() {
        BufferedImage src = syntheticMap();
        FloorPlanRenderer.Result r = new FloorPlanRenderer().renderPlan(src);

        FloorPlanGeometry.PlanMeta raw = new FloorPlanGeometry.PlanMeta(0.05, -1.5, -2.0, 0.0);
        FloorPlanGeometry.PlanMeta plan = FloorPlanGeometry.transformMeta(
                raw, src.getHeight(), r.rawToOut(), r.image().getHeight());

        // 불변식: 같은 물리 지점은 원본 메타로 계산하든 도면 메타로 계산하든 동일 월드좌표
        double[][] samples = {{18, 20}, {29, 20}, {45, 10}};
        for (double[] p : samples) {
            double[] worldRaw = FloorPlanGeometry.worldOfRaw(p[0], p[1], raw, src.getHeight());
            double outX = r.rawToOut()[0] * p[0] + r.rawToOut()[1] * p[1] + r.rawToOut()[2];
            double outY = r.rawToOut()[3] * p[0] + r.rawToOut()[4] * p[1] + r.rawToOut()[5];
            double[] worldPlan = FloorPlanGeometry.worldOfRaw(
                    // 도면 메타 기준: 도면 픽셀 → 월드 (동일 공식 재사용)
                    outX, outY, plan, r.image().getHeight());
            assertThat(worldPlan[0]).isCloseTo(worldRaw[0], within(1e-6));
            assertThat(worldPlan[1]).isCloseTo(worldRaw[1], within(1e-6));
        }

        // 스케일 10, 회전 0 근처 → 도면 해상도는 원본의 약 1/10
        assertThat(plan.resolution()).isCloseTo(raw.resolution() / 10.0, within(1e-4));
    }

    @Test
    void emptyMapProducesBlankPlanWithIdentityTransform() {
        int w = 10, h = 10;
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                img.setRGB(x, y, UNKNOWN); // free 없음
            }
        }
        FloorPlanRenderer.Result r = new FloorPlanRenderer().renderPlan(img);
        assertThat(r.image().getWidth()).isEqualTo(w);
        assertThat(r.deskewDegrees()).isZero();
        assertThat(r.rawToOut()).containsExactly(1, 0, 0, 0, 1, 0);
    }
}
