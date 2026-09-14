package com.bbiyong.server.map.floorplan;

/**
 * 도면 렌더링(스케일·회전·패딩) 후에도 픽셀↔월드 좌표 정합을 유지하기 위한
 * 맵 메타(resolution/origin/yaw) 변환 유틸. (S15P11E101-640)
 *
 * <p>ROS map_server 규약: origin 은 이미지 <b>좌하단 모서리</b>의 월드 pose,
 * 픽셀 (u,v)(v 는 위→아래) 의 월드좌표는 {@code origin + R(yaw)·(u·res, (h−v)·res)}.
 * 렌더러의 원본픽셀→도면픽셀 아핀 변환을 역산해 도면 기준 메타를 수치적으로 재계산한다.
 */
public final class FloorPlanGeometry {

    private FloorPlanGeometry() {
    }

    /** 맵 메타(resolution m/px, origin 월드 pose). */
    public record PlanMeta(double resolution, double originX, double originY, double originYaw) {
    }

    /**
     * 원본 메타 + 원본픽셀→도면픽셀 아핀 변환으로 도면 메타를 계산한다.
     *
     * @param raw         원본 맵 메타
     * @param rawHeightPx 원본 이미지 높이(px)
     * @param rawToOut    원본픽셀→도면픽셀 아핀 [a,b,c,d,e,f]
     * @param outHeightPx 도면 이미지 높이(px)
     */
    public static PlanMeta transformMeta(PlanMeta raw, int rawHeightPx, double[] rawToOut, int outHeightPx) {
        double[] p0 = worldOfOut(0, outHeightPx, raw, rawHeightPx, rawToOut);   // 도면 좌하단 모서리
        double[] p1 = worldOfOut(1, outHeightPx, raw, rawHeightPx, rawToOut);   // +u' 방향 1px
        double dx = p1[0] - p0[0];
        double dy = p1[1] - p0[1];
        double resolution = Math.hypot(dx, dy);
        double yaw = Math.atan2(dy, dx);
        return new PlanMeta(resolution, p0[0], p0[1], yaw);
    }

    /** 도면 픽셀평면 좌표 (X,Y) 의 월드좌표. (원본 아핀 역변환 → ROS 규약 적용) */
    public static double[] worldOfOut(double outX, double outY,
                                      PlanMeta raw, int rawHeightPx, double[] rawToOut) {
        double a = rawToOut[0], b = rawToOut[1], c = rawToOut[2];
        double d = rawToOut[3], e = rawToOut[4], f = rawToOut[5];
        double det = a * e - b * d;
        double rx = (e * (outX - c) - b * (outY - f)) / det;
        double ry = (-d * (outX - c) + a * (outY - f)) / det;
        return worldOfRaw(rx, ry, raw, rawHeightPx);
    }

    /** 원본 픽셀평면 좌표 (px,py) 의 월드좌표. */
    public static double[] worldOfRaw(double px, double py, PlanMeta raw, int rawHeightPx) {
        double vx = px * raw.resolution();
        double vy = (rawHeightPx - py) * raw.resolution();
        double cos = Math.cos(raw.originYaw());
        double sin = Math.sin(raw.originYaw());
        return new double[]{
                raw.originX() + cos * vx - sin * vy,
                raw.originY() + sin * vx + cos * vy,
        };
    }
}
