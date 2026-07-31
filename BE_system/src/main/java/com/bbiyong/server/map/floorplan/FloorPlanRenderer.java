package com.bbiyong.server.map.floorplan;

import java.awt.image.BufferedImage;
import java.util.ArrayDeque;
import java.util.Deque;

/**
 * SLAM 점유격자(원본)를 정제해 직관적인 2D 도면(흑백)으로 변환한다. (S15P11E101-518)
 *
 * <p>순수 Java(java.awt) 래스터 처리:
 * <ol>
 *   <li>벽 마스크 추출: 어두운(occupied) 픽셀 = 벽. 밝은(free)·중간(unknown)은 비-벽.</li>
 *   <li>스캔 잡티 제거: 작은 연결요소(작은 검은 점) 삭제.</li>
 *   <li>morphology close(팽창→침식): 벽 끊김 메움 후 재정제.</li>
 *   <li>출력: 흰 배경 + 검은 벽의 깔끔한 도면.</li>
 * </ol>
 * OpenCV 미사용. 격자 이미지(수백 px)에서 충분히 가볍다.
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

        boolean[][] wall = new boolean[h][w];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int argb = src.getRGB(x, y);
                int a = (argb >>> 24) & 0xff;
                int r = (argb >> 16) & 0xff;
                int g = (argb >> 8) & 0xff;
                int b = argb & 0xff;
                int gray = (r * 299 + g * 587 + b * 114) / 1000;
                // 투명 픽셀은 자유공간(비-벽)으로 간주. 어두운 픽셀만 벽.
                wall[y][x] = a > 10 && gray < wallThreshold;
            }
        }

        removeSmallComponents(wall, minWallBlob);
        boolean[][] closed = erode(dilate(wall));   // close: 벽 끊김 메움
        removeSmallComponents(closed, minWallBlob);  // close 후 재정제

        BufferedImage out = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                out.setRGB(x, y, closed[y][x] ? 0x000000 : 0xFFFFFF);
            }
        }
        return out;
    }

    /** 3x3 팽창(dilation). 이웃에 벽이 하나라도 있으면 벽. */
    private boolean[][] dilate(boolean[][] m) {
        int h = m.length, w = m[0].length;
        boolean[][] out = new boolean[h][w];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                boolean on = false;
                for (int dy = -1; dy <= 1 && !on; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        int ny = y + dy, nx = x + dx;
                        if (ny >= 0 && ny < h && nx >= 0 && nx < w && m[ny][nx]) {
                            on = true;
                            break;
                        }
                    }
                }
                out[y][x] = on;
            }
        }
        return out;
    }

    /** 3x3 침식(erosion). 3x3 이웃이 모두 벽이어야 벽(경계는 비-벽). */
    private boolean[][] erode(boolean[][] m) {
        int h = m.length, w = m[0].length;
        boolean[][] out = new boolean[h][w];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                boolean all = true;
                for (int dy = -1; dy <= 1 && all; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        int ny = y + dy, nx = x + dx;
                        if (ny < 0 || ny >= h || nx < 0 || nx >= w || !m[ny][nx]) {
                            all = false;
                            break;
                        }
                    }
                }
                out[y][x] = all;
            }
        }
        return out;
    }

    /** minArea 미만인 벽 연결요소(8-이웃)를 제거한다(잡티 제거). in-place. */
    private void removeSmallComponents(boolean[][] m, int minArea) {
        int h = m.length, w = m[0].length;
        boolean[][] visited = new boolean[h][w];
        int[] dx = {-1, 0, 1, -1, 1, -1, 0, 1};
        int[] dy = {-1, -1, -1, 0, 0, 1, 1, 1};
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (!m[y][x] || visited[y][x]) {
                    continue;
                }
                Deque<int[]> stack = new ArrayDeque<>();
                Deque<int[]> comp = new ArrayDeque<>();
                stack.push(new int[]{x, y});
                visited[y][x] = true;
                while (!stack.isEmpty()) {
                    int[] p = stack.pop();
                    comp.push(p);
                    for (int k = 0; k < 8; k++) {
                        int nx = p[0] + dx[k], ny = p[1] + dy[k];
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h && m[ny][nx] && !visited[ny][nx]) {
                            visited[ny][nx] = true;
                            stack.push(new int[]{nx, ny});
                        }
                    }
                }
                if (comp.size() < minArea) {
                    for (int[] p : comp) {
                        m[p[1]][p[0]] = false;
                    }
                }
            }
        }
    }
}
