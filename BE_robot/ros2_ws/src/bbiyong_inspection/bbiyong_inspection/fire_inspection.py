#!/usr/bin/env python3
"""Fire/overheat inspection: pick a rotatable spot, add it to the patrol route,
and do a stop-and-stare 360 deg sweep when the patrol gets there.

WHAT THIS NODE IS NOT
---------------------
It does **not** decide whether there is a fire. That judgement lives in one
place -- ``cloud_bridge`` / ``hazard_fusion`` -- and arrives here already
confirmed via ``/dev/shm/orincar_fire.json``. A second M-of-N here would drift
from the first and produce "the dashboard says fire but the robot never
inspected" (design doc 2026-08-10 §4, option b).

WHAT IT DOES
------------
1. Reads confirmed hazard pings (map frame, = the robot's own pose at the
   moment of confirmation).
2. Decides whether the robot could turn 360 deg in place there, **from the live
   scan** -- not from the stored map. The 2026-08-10 entrapment was caused by an
   object that was not in the saved map at all (8 cm inside the wall line, 0%
   detection rate from other poses), so a map-only check cannot see it.
3. If it could not, searches outward for the nearest spot that passes **both**
   the scan test and the stored-map clearance test. Both are required: the scan
   is what physically stops the robot, and ``patrol_route`` silently rejects a
   whole route whose waypoint is under ``min_waypoint_obstacle_clearance_m``
   (0.30 m) on the map.
4. Appends that spot to the patrol route JSON as one extra waypoint.
   ``patrol_route`` picks it up by mtime -- no new topic or service.
5. When the patrol actually arrives there, sweeps 40 deg x 9 via the Nav2
   ``Spin`` action with a stare pause between steps.

WHY Spin AND NOT WAYPOINT HEADINGS
----------------------------------
``yaw_goal_tolerance`` is 6.28 rad (= 2*pi) in ``nav2_diff.yaml``, deliberately
opened up for arrival rate. Goal headings are therefore ignored, so "nine
waypoints at the same place with different yaw" cannot work. ``Spin`` commands
a rotation directly and is unaffected.

Spin also keeps us on the single drive path: behavior_server -> /cmd_vel_nav ->
velocity_floor -> collision_monitor -> cmd_mux. This node never publishes Twist.

🔴 OPEN: THE PATROL HOLD
------------------------
While ``FollowWaypoints`` has an active goal, ``controller_server`` is also
driving. If we start a ``Spin`` at the same time, two Nav2 servers publish to
/cmd_vel_nav and the result is undefined. So the sweep needs the patrol to
stand down for its ~35 s.

There is no such hook today, and the two obvious substitutes are both wrong:
  - publishing "manual" on /bbiyong/control_mode -- **cmd_mux subscribes to that
    same topic** and would gate the Spin's own output to the wheels;
  - cancelling the FollowWaypoints goal -- ``patrol_route._drive_state`` re-sends
    a new goal on the very next 10 Hz tick, so there is no window.

This node therefore asks for a hold on ``/bbiyong/inspection/hold`` and **will
not spin until something acknowledges it** on ``/bbiyong/inspection/hold_ack``.
Refusing is the safe default: an unacknowledged sweep would be a two-driver
fight on a live robot. Honouring the hold is a small follow-up change in
``patrol_route`` (treat hold as "motion not allowed" in ``_motion_allowed``),
deliberately left out of this change set.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import threading
import time

from action_msgs.msg import GoalStatus
from nav2_msgs.action import Spin
from nav_msgs.msg import OccupancyGrid
import rclpy
from rclpy.action import ActionClient
from rclpy.callback_groups import ReentrantCallbackGroup
from rclpy.duration import Duration
from rclpy.executors import MultiThreadedExecutor
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from sensor_msgs.msg import LaserScan
from std_msgs.msg import Bool, String
from tf2_ros import (Buffer, ConnectivityException, ExtrapolationException,
                     LookupException, TransformListener)

# 🔴 실측값의 정본은 escape_recovery 다. 여기서 숫자를 다시 적으면 차체를 바꿨을 때
#    한쪽만 고쳐져 두 노드가 서로 다른 차체를 가정하게 된다. 상수만 가져오고
#    (아래 두 함수는 메서드라 그대로 못 쓴다) 계산은 같은 식으로 다시 쓴다.
from bbiyong_base.escape_recovery import (CIRCUM_RADIUS, FRONT_EXTENT,
                                          HALF_WIDTH, LX, LY, LYAW,
                                          REAR_EXTENT)


def latched_qos():
    qos = QoSProfile(depth=1)
    qos.durability = DurabilityPolicy.TRANSIENT_LOCAL
    qos.reliability = ReliabilityPolicy.RELIABLE
    return qos


def foot_radius(phi):
    """차체 중심에서 방위 phi 의 footprint 경계까지 거리 (직사각형).

    escape_recovery._foot_radius 와 같은 식이다.
    """
    c, s = math.cos(phi), math.sin(phi)
    rx = (FRONT_EXTENT if c >= 0.0 else REAR_EXTENT) / abs(c) if abs(c) > 1e-9 else 1e9
    ry = HALF_WIDTH / abs(s) if abs(s) > 1e-9 else 1e9
    return min(rx, ry)


def scan_points(scan):
    """LaserScan 을 base_link (x, y) 목록으로.

    🔴 두 가지를 빠뜨리면 안 된다.
      ① 마운트 회전 LYAW(-175.7 deg). 라이다가 거의 뒤를 보고 달려 있어, 빼면
         앞뒤 판정이 정반대가 된다.
      ② range_max 밖의 값. `/scan` 에 섞인 11.0(= range_max + 1) 은 실측이 아니라
         scan_filter.yaml 의 `unstable_rear_left_sector` 마스크다. 거리로 쓰면
         "그 방향은 11 m 까지 비어 있다" 는 거짓말이 된다. 아래 range 검사가
         그대로 걸러낸다. NaN(차체 박스필터)도 마찬가지.
    """
    if scan is None:
        return []
    points = []
    for index, distance in enumerate(scan.ranges):
        if not math.isfinite(distance):
            continue
        if not (scan.range_min < distance < scan.range_max):
            continue
        angle = scan.angle_min + index * scan.angle_increment + LYAW
        points.append((LX + distance * math.cos(angle),
                       LY + distance * math.sin(angle)))
    return points


def clearance_at(points, x, y):
    """base_link 좌표 (x, y) 에서 가장 가까운 스캔 점까지 거리. 점이 없으면 None.

    None 은 "장애물이 없다" 가 아니라 **"모른다"** 다 — 호출부는 이것을 통과로
    다뤄서는 안 된다.
    """
    best = None
    for px, py in points:
        d = math.hypot(px - x, py - y)
        if best is None or d < best:
            best = d
    return best


def visible_from_origin(points, x, y, corridor_m):
    """원점에서 (x, y) 로 곧게 가는 길이 스캔 점에 막히지 않았으면 True.

    가림 뒤쪽은 스캔에 안 담기므로 "비어 보인다" 가 곧 "비었다" 가 아니다.
    그래서 후보를 **지금 자리에서 직선으로 보이는** 방향으로만 제한한다.
    선분에서 corridor_m 안쪽에 점이 있으면 막힌 것으로 본다.
    """
    length = math.hypot(x, y)
    if length < 1e-6:
        return True
    ux, uy = x / length, y / length
    for px, py in points:
        along = px * ux + py * uy
        if along <= 0.0 or along >= length:
            continue                      # 선분 구간 밖은 통행에 무관하다
        lateral = abs(-px * uy + py * ux)
        if lateral < corridor_m:
            return False
    return True


class FireInspection(Node):
    def __init__(self):
        super().__init__("bbiyong_fire_inspection")

        self.declare_parameter("fire_state_file", "/dev/shm/orincar_fire.json")
        self.declare_parameter(
            "route_file", "~/.local/state/bbiyong/patrol_route.json")
        self.declare_parameter("scan_topic", "/scan")
        self.declare_parameter("map_topic", "/map")
        self.declare_parameter("global_frame", "map")
        self.declare_parameter("base_frame", "base_link")
        self.declare_parameter("poll_period_sec", 1.0)

        # 제자리 회전에 필요한 여유. escape_recovery 의 rotation_clear_m 기본값과
        # 같은 식(외접반경 + 0.03)이다 — 같은 차체를 두 노드가 다르게 판정하면
        # "탈출은 돌 수 있다는데 검사는 못 돈다" 가 된다.
        self.declare_parameter("rotation_clear_m", CIRCUM_RADIUS + 0.03)
        # 지도 기준 여유. patrol_route 의 min_waypoint_obstacle_clearance_m 가
        # 0.30 이고 **미달이면 경로 전체가 조용히 거부된다.** 지도 셀이 0.05 m 라
        # 한 셀분을 더 얹어 격자 이산화로 아슬아슬하게 떨어지는 것을 막는다.
        self.declare_parameter("map_clearance_m", 0.35)

        # 후보 격자 (설계 문서 §3-2).
        self.declare_parameter("search_bearing_step_deg", 10.0)
        self.declare_parameter("search_range_step_m", 0.1)
        self.declare_parameter("search_max_m", 1.5)
        # 직선 통행 판정 통로 반폭. 반폭(0.184)보다 좁으면 못 지나갈 틈을
        # 지나갈 수 있다고 본다.
        self.declare_parameter("corridor_half_width_m", HALF_WIDTH)

        # 40 deg x 9 = 360 deg. 응시 2.5초는 FireGate 확정에 5틱 중 3틱(틱 0.5초)이
        # 필요하다는 데서 온다 — 이보다 짧으면 서 있는 동안 확정이 안 될 수 있다.
        # 회전 1.4초 + 응시 2.5초 = 3.9초, x9 = 약 35초. 사용자 기준 "1분 이상
        # 정지는 실패" 안쪽이다.
        self.declare_parameter("spin_steps", 9)
        self.declare_parameter("spin_step_deg", 40.0)
        self.declare_parameter("dwell_sec", 2.5)
        self.declare_parameter("spin_timeout_sec", 10.0)

        # 도착 판정. Nav2 의 xy_goal_tolerance 가 0.10 이므로 순찰은 그 안으로
        # 들어온다. 0.30 은 AMCL 자세 흔들림에 3배 여유를 두면서도 순찰
        # 웨이포인트 간격(실측 경로에서 최소 1.09 m)보다 한참 작다.
        self.declare_parameter("arrival_radius_m", 0.30)

        self.fire_state_file = str(self.get_parameter("fire_state_file").value)
        self.route_file = Path(
            str(self.get_parameter("route_file").value)).expanduser()
        self.global_frame = str(self.get_parameter("global_frame").value)
        self.base_frame = str(self.get_parameter("base_frame").value)
        self.rotation_clear = float(self.get_parameter("rotation_clear_m").value)
        self.map_clearance = float(self.get_parameter("map_clearance_m").value)
        self.bearing_step = math.radians(
            float(self.get_parameter("search_bearing_step_deg").value))
        self.range_step = float(self.get_parameter("search_range_step_m").value)
        self.search_max = float(self.get_parameter("search_max_m").value)
        self.corridor = float(self.get_parameter("corridor_half_width_m").value)
        self.spin_steps = int(self.get_parameter("spin_steps").value)
        self.spin_step = math.radians(
            float(self.get_parameter("spin_step_deg").value))
        self.dwell = float(self.get_parameter("dwell_sec").value)
        self.spin_timeout = float(self.get_parameter("spin_timeout_sec").value)
        self.arrival_radius = float(self.get_parameter("arrival_radius_m").value)

        self.scan = None
        self.map = None
        self.state_mtime_ns = None
        self.handled = {}        # ping id -> {"x","y"} (map frame) 검사 지점
        self.swept = set()       # 이미 훑은 ping id
        self.hold_ack = False
        self.busy = False        # 스윕 진행 중 (재진입 방지)

        self.create_subscription(
            LaserScan, str(self.get_parameter("scan_topic").value),
            self._on_scan, 10)
        self.create_subscription(
            OccupancyGrid, str(self.get_parameter("map_topic").value),
            self._on_map, latched_qos())
        self.create_subscription(
            Bool, "/bbiyong/inspection/hold_ack", self._on_hold_ack,
            latched_qos())
        self.hold_publisher = self.create_publisher(
            Bool, "/bbiyong/inspection/hold", latched_qos())
        self.status_publisher = self.create_publisher(
            String, "/bbiyong/inspection/fire_status", latched_qos())

        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)
        # 스윕 스레드가 액션 결과를 기다리는 동안에도 실행기가 그 콜백을 처리해야
        # 한다 — 재진입 그룹 + MultiThreadedExecutor(main) 조합이 그것을 보장한다.
        self.spin_client = ActionClient(
            self, Spin, "/spin", callback_group=ReentrantCallbackGroup())

        period = float(self.get_parameter("poll_period_sec").value)
        self.create_timer(period, self._tick)
        self.get_logger().info(
            f"fire inspection ready: rotation_clear={self.rotation_clear:.3f}m "
            f"map_clearance={self.map_clearance:.2f}m "
            f"sweep={self.spin_steps}x{math.degrees(self.spin_step):.0f}deg "
            f"dwell={self.dwell:.1f}s")

    # ── 입력 ────────────────────────────────────────────────────────────

    def _on_scan(self, message):
        self.scan = message

    def _on_map(self, message):
        self.map = message

    def _on_hold_ack(self, message):
        self.hold_ack = bool(message.data)

    def _robot_pose(self):
        """map 프레임에서의 (x, y, yaw). 모르면 None."""
        try:
            tf = self.tf_buffer.lookup_transform(
                self.global_frame, self.base_frame, rclpy.time.Time())
        except (LookupException, ConnectivityException, ExtrapolationException):
            return None
        t = tf.transform.translation
        q = tf.transform.rotation
        yaw = math.atan2(2.0 * (q.w * q.z + q.x * q.y),
                         1.0 - 2.0 * (q.y * q.y + q.z * q.z))
        return t.x, t.y, yaw

    def _read_pings(self):
        """확정 핑 목록. 파일이 안 바뀌었으면 None (일 없음)."""
        try:
            mtime_ns = os.stat(self.fire_state_file).st_mtime_ns
        except OSError:
            return None
        if mtime_ns == self.state_mtime_ns:
            return None
        self.state_mtime_ns = mtime_ns
        try:
            with open(self.fire_state_file, encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            self.get_logger().warning("unreadable fire state file; skipping")
            return None
        pings = payload.get("pings")
        return pings if isinstance(pings, list) else []

    # ── 지도 기준 여유 ──────────────────────────────────────────────────

    def _map_clearance(self, x, y, search_radius):
        """map 좌표 (x, y) 에서 점유 셀까지 최소 거리. 지도가 없으면 None.

        patrol_route._nearest_obstacle_distance 와 같은 판정(점유 임계 65)을 쓴다 —
        여기서 통과시킨 점을 저쪽이 거부하면 경로가 조용히 안 바뀐다.
        """
        grid = self.map
        if grid is None:
            return None
        resolution = grid.info.resolution
        if resolution <= 0.0:
            return None
        origin_x = grid.info.origin.position.x
        origin_y = grid.info.origin.position.y
        span = max(1, int(search_radius / resolution))
        cx = int((x - origin_x) / resolution)
        cy = int((y - origin_y) / resolution)
        best = search_radius
        found = False
        for gy in range(max(0, cy - span), min(grid.info.height, cy + span + 1)):
            row = gy * grid.info.width
            for gx in range(max(0, cx - span),
                            min(grid.info.width, cx + span + 1)):
                if grid.data[row + gx] < 65:
                    continue
                px = origin_x + (gx + 0.5) * resolution
                py = origin_y + (gy + 0.5) * resolution
                d = math.hypot(px - x, py - y)
                if d < best:
                    best = d
                    found = True
        return best if found else search_radius

    # ── 후보 선정 ───────────────────────────────────────────────────────

    def _acceptable(self, points, bx, by, pose):
        """base_link 후보 (bx, by) 가 라이다·지도 두 기준을 다 통과하면 map 좌표."""
        near = clearance_at(points, bx, by)
        if near is None or near < self.rotation_clear:
            return None
        if not visible_from_origin(points, bx, by, self.corridor):
            return None
        x, y, yaw = pose
        mx = x + bx * math.cos(yaw) - by * math.sin(yaw)
        my = y + bx * math.sin(yaw) + by * math.cos(yaw)
        map_clear = self._map_clearance(mx, my, self.map_clearance)
        if map_clear is None or map_clear < self.map_clearance:
            return None
        return mx, my

    def _choose_inspection_point(self, ping, pose, points):
        """검사 지점을 고른다: 핑 자리가 되면 그대로, 아니면 최근접 대안."""
        x, y, yaw = pose
        # 핑을 base_link 로. 핑은 확정 순간의 로봇 자기 위치라 보통 원점 근처다.
        dx, dy = ping["x"] - x, ping["y"] - y
        c, s = math.cos(-yaw), math.sin(-yaw)
        bx, by = dx * c - dy * s, dx * s + dy * c

        here = self._acceptable(points, bx, by, pose)
        if here is not None:
            return here, 0.0

        steps = int(self.search_max / self.range_step)
        bearings = int(round(2.0 * math.pi / self.bearing_step))
        # 거리를 바깥 루프로 둔다 — 먼저 찾은 것이 곧 가장 가까운 것이다.
        for step in range(1, steps + 1):
            radius = step * self.range_step
            for index in range(bearings):
                phi = index * self.bearing_step
                cand = self._acceptable(
                    points, bx + radius * math.cos(phi),
                    by + radius * math.sin(phi), pose)
                if cand is not None:
                    return cand, radius
        return None, None

    # ── 경로 갱신 ───────────────────────────────────────────────────────

    def _append_waypoint(self, x, y, name):
        """경로 JSON 뒤에 웨이포인트 1개를 덧붙인다.

        🔴 sessionId(그리고 나머지 메타데이터)를 **그대로 보존**해야 한다.
        patrol_route._reload_route 는 route_matches_session 으로 대조하고,
        어긋나면 로그 한 줄만 남기고 경로를 안 바꾼다.

        🔴 반드시 **덧붙임**이어야 한다. 기존 웨이포인트를 순서·좌표 그대로 두고
        뒤에만 늘려야 patrol_route.route_is_appended 가 인정해 resume_index 를
        유지한다. 하나라도 건드리면 순찰이 그 바퀴를 처음부터 다시 시작한다.
        """
        try:
            with open(self.route_file, encoding="utf-8") as handle:
                document = json.load(handle)
        except (OSError, ValueError) as exc:
            self.get_logger().error(f"cannot read route file: {exc}")
            return False
        waypoints = document.get("waypoints")
        if not isinstance(waypoints, list) or not waypoints:
            self.get_logger().error("route file has no waypoints; not touching it")
            return False
        next_seq = max(int(point.get("seq", 0)) for point in waypoints) + 1
        waypoints.append({
            "name": name, "seq": next_seq,
            "x": round(float(x), 3), "y": round(float(y), 3),
            # yaw 는 지정하지 않는다. yaw_goal_tolerance 가 2*pi 라 어차피
            # 무시되고, 방향은 Spin 이 직접 만든다.
            "yaw": None,
        })
        document["updatedAt"] = time.time()
        temporary = str(self.route_file) + f".tmp-{os.getpid()}"
        try:
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(document, handle)
            # 원자 교체. patrol_route 는 mtime 을 1 Hz 로 보므로, 반쯤 쓰인
            # 파일을 읽을 창을 남기면 안 된다.
            os.replace(temporary, self.route_file)
        except OSError as exc:
            self.get_logger().error(f"cannot write route file: {exc}")
            return False
        self.get_logger().info(
            f"appended inspection waypoint seq={next_seq} at "
            f"({x:.2f}, {y:.2f}); route now {len(waypoints)} waypoints")
        return True

    # ── 회전 검사 ───────────────────────────────────────────────────────

    @staticmethod
    def _await(future, timeout_sec):
        """future 가 끝나기를 기다린다. 끝났으면 True.

        🔴 `rclpy.spin_until_future_complete` 를 쓰면 안 된다 — 이 함수는
        **콜백 안에서** 불리고, 거기서 실행기를 다시 돌리는 것은 재진입이다.
        스윕은 별도 스레드에서 돌고 실행기는 주 스레드에서 계속 돌고 있으므로,
        여기서는 그냥 결과가 채워지기를 기다리면 된다.
        """
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            if future.done():
                return True
            time.sleep(0.02)
        return future.done()

    def _sweep(self, ping_id):
        """40 deg x spin_steps 정지-응시 스윕. 성공하면 True.

        약 35초 동안 블로킹하므로 **전용 스레드에서** 돈다(_sweep_if_arrived).
        재진입은 self.busy 로 막는다.
        """
        if not self.spin_client.wait_for_server(timeout_sec=2.0):
            self.get_logger().error("no /spin action server; skipping sweep")
            return False
        for step in range(self.spin_steps):
            goal = Spin.Goal()
            goal.target_yaw = float(self.spin_step)
            goal.time_allowance = Duration(seconds=self.spin_timeout).to_msg()
            send = self.spin_client.send_goal_async(goal)
            if not self._await(send, self.spin_timeout):
                self.get_logger().error(
                    f"spin step {step + 1}/{self.spin_steps} was never accepted "
                    "or rejected; aborting sweep")
                return False
            handle = send.result()
            if handle is None or not handle.accepted:
                self.get_logger().error(
                    f"spin step {step + 1}/{self.spin_steps} rejected; "
                    "aborting sweep")
                return False
            result = handle.get_result_async()
            if (not self._await(result, self.spin_timeout)
                    or result.result().status != GoalStatus.STATUS_SUCCEEDED):
                # 한 단계가 실패해도 스윕은 계속한다 — 남은 방향을 포기하는
                # 것보다 낫다. 다만 그 방향은 안 본 것이므로 로그를 남긴다.
                self.get_logger().warning(
                    f"spin step {step + 1}/{self.spin_steps} did not succeed; "
                    "continuing the sweep")
            # 응시. 도는 중에는 카메라 잔상으로 판정이 안 되므로, 서 있는 시간이
            # 곧 검출 기회다. FireGate 확정에 필요한 2.5초를 준다.
            time.sleep(self.dwell)
            self._publish_status({
                "phase": "SWEEPING", "pingId": ping_id,
                "step": step + 1, "steps": self.spin_steps})
        return True

    def _publish_status(self, payload):
        self.status_publisher.publish(String(data=json.dumps(payload)))

    # ── 주기 ────────────────────────────────────────────────────────────

    def _tick(self):
        if self.busy:
            return
        self._plan_new_pings()
        self._sweep_if_arrived()

    def _plan_new_pings(self):
        pings = self._read_pings()
        if pings is None:
            return
        live = {p.get("id") for p in pings if p.get("id")}
        # 사라진 핑(해소됨)은 잊는다 — 재발화하면 새 id 로 다시 온다.
        for ping_id in list(self.handled):
            if ping_id not in live:
                self.handled.pop(ping_id, None)
                self.swept.discard(ping_id)

        for ping in pings:
            ping_id = ping.get("id")
            if not ping_id or ping_id in self.handled:
                continue
            if ping.get("x") is None or ping.get("y") is None:
                continue
            pose = self._robot_pose()
            points = scan_points(self.scan)
            if pose is None or not points or self.map is None:
                # 다음 틱에 다시 본다. state_mtime_ns 를 이미 올렸으므로 파일이
                # 안 바뀌면 _read_pings 가 None 을 준다 — 그래서 여기서 되돌린다.
                self.state_mtime_ns = None
                self.get_logger().warning(
                    "waiting for pose/scan/map before planning inspection")
                return
            point, moved = self._choose_inspection_point(ping, pose, points)
            if point is None:
                self.get_logger().error(
                    f"no rotatable spot within {self.search_max:.1f} m of ping "
                    f"({ping['x']:.2f}, {ping['y']:.2f}); no waypoint added")
                # 다시 시도하지 않는다 — 같은 스캔으로는 같은 결론이 나온다.
                self.handled[ping_id] = None
                self._publish_status(
                    {"phase": "NO_ROTATABLE_SPOT", "pingId": ping_id})
                continue
            if not self._append_waypoint(
                    point[0], point[1], f"fire-{ping_id[:8]}"):
                self.state_mtime_ns = None      # 다음 틱에 재시도
                return
            self.handled[ping_id] = {"x": point[0], "y": point[1]}
            self.get_logger().info(
                f"inspection point for ping {ping_id[:8]}: "
                f"({point[0]:.2f}, {point[1]:.2f}), moved {moved:.2f} m")
            self._publish_status({
                "phase": "WAYPOINT_ADDED", "pingId": ping_id,
                "x": point[0], "y": point[1], "movedM": round(moved, 3)})

    def _sweep_if_arrived(self):
        pose = self._robot_pose()
        if pose is None:
            return
        for ping_id, point in self.handled.items():
            if point is None or ping_id in self.swept:
                continue
            if math.hypot(point["x"] - pose[0],
                          point["y"] - pose[1]) > self.arrival_radius:
                continue
            # 🔴 순찰이 서 주지 않으면 돌지 않는다. 위 모듈 독스트링 참고 —
            #    응답 없이 도는 것은 controller_server 와의 두 갈래 주행이다.
            self.hold_publisher.publish(Bool(data=True))
            if not self.hold_ack:
                self.get_logger().warning(
                    "arrived at the inspection point but the patrol hold is "
                    "unacknowledged; refusing to spin (see module docstring)")
                self._publish_status(
                    {"phase": "HOLD_NOT_ACKNOWLEDGED", "pingId": ping_id})
                self.hold_publisher.publish(Bool(data=False))
                return
            self.busy = True
            self._publish_status({"phase": "SWEEP_START", "pingId": ping_id})
            # 실행기를 막지 않도록 전용 스레드에서 돈다. 그래야 스윕이 도는
            # 동안에도 Spin 액션의 결과 콜백이 실행기에서 처리된다.
            threading.Thread(
                target=self._run_sweep, args=(ping_id,), daemon=True).start()
            return

    def _run_sweep(self, ping_id):
        try:
            ok = self._sweep(ping_id)
        finally:
            self.hold_publisher.publish(Bool(data=False))
            self.swept.add(ping_id)
            self.busy = False
        self._publish_status({
            "phase": "SWEEP_DONE" if ok else "SWEEP_FAILED",
            "pingId": ping_id})


def main(args=None):
    rclpy.init(args=args)
    node = FireInspection()
    executor = MultiThreadedExecutor()
    executor.add_node(node)
    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
