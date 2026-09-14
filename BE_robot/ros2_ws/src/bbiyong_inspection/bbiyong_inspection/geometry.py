"""Pure occupancy-grid and camera-ray geometry, kept independent of ROS."""

from __future__ import annotations

import math


def normalize2(x, y):
    length = math.hypot(x, y)
    if length <= 1e-9:
        raise ValueError("direction has zero horizontal length")
    return x / length, y / length


def quaternion_rotate(vector, quaternion):
    """Rotate a 3-vector by a quaternion in x,y,z,w order."""
    vx, vy, vz = vector
    qx, qy, qz, qw = quaternion
    tx = 2.0 * (qy * vz - qz * vy)
    ty = 2.0 * (qz * vx - qx * vz)
    tz = 2.0 * (qx * vy - qy * vx)
    return (
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    )


class GridMap:
    def __init__(self, width, height, resolution, origin_x, origin_y, origin_yaw, data):
        if width <= 0 or height <= 0 or resolution <= 0.0:
            raise ValueError("invalid occupancy-grid dimensions")
        if len(data) != width * height:
            raise ValueError("occupancy-grid data length mismatch")
        self.width = int(width)
        self.height = int(height)
        self.resolution = float(resolution)
        self.origin_x = float(origin_x)
        self.origin_y = float(origin_y)
        self.origin_yaw = float(origin_yaw)
        self.data = data
        self._cos = math.cos(self.origin_yaw)
        self._sin = math.sin(self.origin_yaw)

    def world_to_cell(self, x, y):
        dx, dy = x - self.origin_x, y - self.origin_y
        local_x = self._cos * dx + self._sin * dy
        local_y = -self._sin * dx + self._cos * dy
        return math.floor(local_x / self.resolution), math.floor(local_y / self.resolution)

    def cell_to_world(self, col, row):
        local_x = (col + 0.5) * self.resolution
        local_y = (row + 0.5) * self.resolution
        return (
            self.origin_x + self._cos * local_x - self._sin * local_y,
            self.origin_y + self._sin * local_x + self._cos * local_y,
        )

    def inside(self, col, row):
        return 0 <= col < self.width and 0 <= row < self.height

    def occupancy(self, col, row):
        if not self.inside(col, row):
            return None
        return int(self.data[row * self.width + col])

    def is_clear(self, x, y, clearance_m, *, free_threshold=20):
        col, row = self.world_to_cell(x, y)
        radius = max(0, math.ceil(clearance_m / self.resolution))
        for rr in range(row - radius, row + radius + 1):
            for cc in range(col - radius, col + radius + 1):
                if (cc - col) ** 2 + (rr - row) ** 2 > radius ** 2:
                    continue
                value = self.occupancy(cc, rr)
                if value is None or value < 0 or value > free_threshold:
                    return False
        return True

    def raycast(self, origin, direction, max_range_m, *, occupied_threshold=65):
        dx, dy = normalize2(direction[0], direction[1])
        step = max(self.resolution * 0.35, 0.01)
        visited = set()
        distance = 0.0
        entered_map = False
        while distance <= max_range_m:
            x = origin[0] + dx * distance
            y = origin[1] + dy * distance
            cell = self.world_to_cell(x, y)
            distance += step
            if cell in visited:
                continue
            visited.add(cell)
            value = self.occupancy(*cell)
            if value is None:
                if entered_map:
                    return None, "ray left map"
                continue
            entered_map = True
            if value < 0:
                return None, "ray entered unknown space"
            if value >= occupied_threshold:
                hit_x, hit_y = self.cell_to_world(*cell)
                return {
                    "x": hit_x,
                    "y": hit_y,
                    "distance": math.hypot(hit_x - origin[0], hit_y - origin[1]),
                    "cell": cell,
                }, ""
        return None, "no occupied cell within range"

    def viewpoint_for_target(
        self,
        target,
        approach_direction,
        stand_off_m,
        clearance_m,
        *,
        lateral_search_m=0.8,
    ):
        dx, dy = normalize2(approach_direction[0], approach_direction[1])
        tangent = (-dy, dx)
        lateral_step = max(self.resolution, 0.05)
        offsets = [0.0]
        count = int(lateral_search_m / lateral_step)
        for index in range(1, count + 1):
            offsets.extend((index * lateral_step, -index * lateral_step))
        for extra in (0.0, 0.15, 0.30, 0.45):
            distance = stand_off_m + extra
            for lateral in offsets:
                x = target[0] - dx * distance + tangent[0] * lateral
                y = target[1] - dy * distance + tangent[1] * lateral
                if self.is_clear(x, y, clearance_m):
                    return {
                        "x": x,
                        "y": y,
                        "yaw": math.atan2(target[1] - y, target[0] - x),
                        "standOffM": math.hypot(target[0] - x, target[1] - y),
                    }
        return None
