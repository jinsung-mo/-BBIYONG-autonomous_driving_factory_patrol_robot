"""Mark where the robot has already driven so the planner prefers a fresh route.

SmacPlanner2D minimises distance *plus* accumulated cell cost
(cost_travel_multiplier 2.0), so making travelled cells moderately expensive --
never lethal -- makes it pick a different way to the next goal, and a different
way home, without either caller knowing this layer exists.

The grid is consumed by a second nav2_costmap_2d::StaticLayer instance in
global_costmap. Three of the choices below are forced by how StaticLayer and
CostmapLayer::updateWithMax actually behave:

  * Untravelled cells are published as -1, not 0. updateWithMax skips cells the
    layer marks unknown, but for a layer value of 0 it runs
    `if (old_cost == NO_INFORMATION || old_cost < layer) master = layer` -- so
    publishing 0 would rewrite every unmapped master cell to free space and let
    the planner route through it despite allow_unknown: false.
  * The grid mirrors /map's geometry exactly. StaticLayer::processMap resizes
    the entire layered costmap to match its incoming grid, so a mismatch would
    leave this layer and the real static layer resizing the master against each
    other every cycle. Geometry changes are republished immediately rather than
    waiting for the next timer tick, to keep that window as short as possible.
  * trail_cost is capped below lethal, so a travelled cell always stays
    traversable and the old route is still taken when it is the only route.

Cost decays with the age of the visit (decay_tau_sec), so the layer expresses
"how recently was I here" rather than "was I ever here". Without decay a long
run eventually paints every reachable cell and the preference goes flat; with
it, a corridor becomes reusable again once it is stale enough to be worth
re-treading. A cell's cost comes from its most recent visit, not the sum of
visits -- one pass stamps a cell several times over (the disk is wider than the
sampling step) and summing would read that as heavy traffic.

Global costmap only. The local costmap feeds RPP's cost-regulated velocity
scaling and the collision monitor, where trail cost would just make the robot
crawl along its own path.

The trail is per-run: frontier_explorer and patrol_route each call ~/reset when
they start, which is exactly one mapping or patrol session. Return-to-start is
deliberately not a reset -- the outbound trail being expensive is what gives a
different way home.

If this node dies or never publishes, StaticLayer logs "no map received" and
navigation continues on the real map -- route diversity is lost, nothing else.
"""

import math
from array import array
from collections import deque

import rclpy
from nav_msgs.msg import OccupancyGrid
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_srvs.srv import Empty
from tf2_ros import (ConnectivityException, ExtrapolationException,
                     LookupException)
from tf2_ros import Buffer, TransformListener

UNKNOWN = b"\xff"          # -1 as int8, i.e. NO_INFORMATION to StaticLayer


def latched_qos():
    """TRANSIENT_LOCAL, to match what StaticLayer subscribes with."""
    qos = QoSProfile(depth=1)
    qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
    qos.reliability = ReliabilityPolicy.RELIABLE
    return qos


class TrailLayer(Node):

    def __init__(self):
        super().__init__("trail_layer")
        self.declare_parameter("map_topic", "/map")
        self.declare_parameter("trail_topic", "/trail_grid")
        self.declare_parameter("global_frame", "map")
        self.declare_parameter("robot_base_frame", "base_link")
        self.declare_parameter("trail_radius_m", 0.25)
        self.declare_parameter("trail_cost", 25)
        self.declare_parameter("sample_distance_m", 0.10)
        self.declare_parameter("sample_period_sec", 0.2)
        self.declare_parameter("publish_period_sec", 1.0)
        self.declare_parameter("decay_tau_sec", 180.0)

        value = lambda key: self.get_parameter(key).value
        self.global_frame = str(value("global_frame"))
        self.robot_base_frame = str(value("robot_base_frame"))
        self.trail_radius_m = float(value("trail_radius_m"))
        self.sample_distance_m = float(value("sample_distance_m"))
        self.decay_tau_sec = float(value("decay_tau_sec"))
        # 99 최대: StaticLayer 는 lethal_cost_threshold(100) 이상을 치명으로 본다.
        self.trail_cost = max(0, min(99, int(value("trail_cost"))))
        # 비용이 1 미만으로 내려가면 그 자취는 더 이상 격자에 나타나지 않는다.
        # 그 시점을 넘긴 점은 기하가 바뀌어 다시 그릴 때도 필요 없으니 버린다.
        self._point_horizon = (
            self.decay_tau_sec * math.log(self.trail_cost)
            if self.decay_tau_sec > 0.0 and self.trail_cost > 1 else 0.0)

        self._info = None        # the /map geometry currently mirrored
        self._offsets = []       # disk stencil, in cells, for that resolution
        self._points = deque()   # (x, y, visited_at); survives geometry changes
        self._cells = {}         # cell index -> most recent visit time

        self._buffer = Buffer()
        self._listener = TransformListener(self._buffer, self)
        self._publisher = self.create_publisher(
            OccupancyGrid, str(value("trail_topic")), latched_qos())
        self.create_subscription(
            OccupancyGrid, str(value("map_topic")), self._on_map, latched_qos())
        self.create_timer(float(value("sample_period_sec")), self._sample_pose)
        self.create_timer(float(value("publish_period_sec")), self._publish)
        self.create_service(Empty, "~/reset", self._on_reset)
        self.get_logger().info(
            f"trail layer up: radius {self.trail_radius_m:.2f} m, "
            f"cost {self.trail_cost}/100 "
            f"(~{int(self.trail_cost * 254 / 100)}/254 in the costmap), "
            f"sampled every {self.sample_distance_m:.2f} m, "
            + (f"decaying with tau {self.decay_tau_sec:.0f}s "
               f"(gone after {self._point_horizon:.0f}s)"
               if self.decay_tau_sec > 0.0 else "no decay"))

    @staticmethod
    def _geometry(info):
        return (info.width, info.height, info.resolution,
                info.origin.position.x, info.origin.position.y)

    def _on_map(self, message):
        if self._info is not None:
            if self._geometry(message.info) == self._geometry(self._info):
                return
        first = self._info is None
        self._info = message.info
        self._offsets = self._disk(message.info.resolution)
        self._rasterise()
        # 기하가 바뀐 즉시 내보낸다 — static_layer 와 크기가 어긋난 창을 최소화한다.
        # 첫 맵에서도 (아직 자취가 없어도) 한 번 내보내야 StaticLayer 가
        # map_received_ 로 올라와 "no map received" 경고를 멈춘다.
        self._publish()
        if first:
            self.get_logger().info(
                f"mirroring /map at {message.info.width}x{message.info.height} "
                f"@ {message.info.resolution:.3f} m/cell")

    def _disk(self, resolution):
        reach = int(math.ceil(self.trail_radius_m / resolution))
        return [(dx, dy)
                for dy in range(-reach, reach + 1)
                for dx in range(-reach, reach + 1)
                if math.hypot(dx, dy) * resolution <= self.trail_radius_m]

    def _stamp(self, x, y, visited_at):
        info = self._info
        # origin yaw 는 무시한다 — slam_toolbox 와 map_server 모두 yaw 0 으로 낸다.
        cx = int((x - info.origin.position.x) / info.resolution)
        cy = int((y - info.origin.position.y) / info.resolution)
        for dx, dy in self._offsets:
            mx, my = cx + dx, cy + dy
            if 0 <= mx < info.width and 0 <= my < info.height:
                index = my * info.width + mx
                # 한 칸의 비용은 가장 최근 방문 하나로 정한다. 합산하면 디스크가
                # 표본 간격보다 넓어 한 번 지나간 것도 여러 번으로 읽힌다.
                previous = self._cells.get(index)
                if previous is None or visited_at > previous:
                    self._cells[index] = visited_at

    def _rasterise(self):
        self._cells = {}
        for x, y, visited_at in self._points:
            self._stamp(x, y, visited_at)

    def _now(self):
        return self.get_clock().now().nanoseconds / 1e9

    def _sample_pose(self):
        if self._info is None:
            return
        try:
            found = self._buffer.lookup_transform(
                self.global_frame, self.robot_base_frame, rclpy.time.Time())
        except (LookupException, ConnectivityException, ExtrapolationException):
            return
        x = found.transform.translation.x
        y = found.transform.translation.y
        if self._points:
            last_x, last_y, _ = self._points[-1]
            if math.hypot(x - last_x, y - last_y) < self.sample_distance_m:
                return
        now = self._now()
        self._points.append((x, y, now))
        self._stamp(x, y, now)
        if self._point_horizon > 0.0:
            horizon = now - self._point_horizon
            while self._points and self._points[0][2] < horizon:
                self._points.popleft()

    def _publish(self):
        if self._info is None:
            return
        info = self._info
        grid = OccupancyGrid()
        grid.header.frame_id = self.global_frame
        grid.header.stamp = self.get_clock().now().to_msg()
        grid.info = info
        data = array("b", UNKNOWN * (info.width * info.height))
        now = self._now()
        faded = []
        for index, visited_at in self._cells.items():
            if self.decay_tau_sec > 0.0:
                weight = math.exp(-(now - visited_at) / self.decay_tau_sec)
                cost = int(round(self.trail_cost * weight))
            else:
                cost = self.trail_cost
            if cost < 1:
                faded.append(index)
                continue
            data[index] = cost
        for index in faded:
            del self._cells[index]
        grid.data = data
        self._publisher.publish(grid)

    def _on_reset(self, request, response):
        self._points.clear()
        self._cells = {}
        self.get_logger().info("trail cleared for a new run")
        self._publish()
        return response


def main():
    rclpy.init()
    node = TrailLayer()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
