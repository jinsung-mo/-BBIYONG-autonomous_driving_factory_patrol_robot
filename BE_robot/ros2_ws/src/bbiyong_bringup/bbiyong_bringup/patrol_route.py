#!/usr/bin/env python3
"""Cancelable Nav2 FollowWaypoints patrol mission; never publishes velocity."""

from __future__ import annotations

import json
from math import atan2, hypot, pi
from pathlib import Path
import signal
import time

import rclpy
from action_msgs.msg import GoalStatus
from builtin_interfaces.msg import Duration as DurationMsg
from geometry_msgs.msg import PoseStamped, PoseWithCovarianceStamped
from nav2_msgs.action import FollowWaypoints, Spin
from nav_msgs.msg import OccupancyGrid
from rclpy.action import ActionClient
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy

from bbiyong_base.qos import CONTROL_STATE_QOS
from std_msgs.msg import Bool, Int32, Int32MultiArray, String
from std_srvs.srv import Empty

from .patrol_route_model import load_route_document, resume_order, yaw_quaternion
from .scouting_session import read_ready_session, route_matches_session


class PatrolRoute(Node):
    def __init__(self):
        super().__init__("bbiyong_patrol_route")
        # trail_layer 는 상시 nav2 스택에 살아 이전 실행의 자취를 들고 있다.
        # 이 노드는 실행마다 새로 뜨므로 여기가 곧 세션 경계다.
        self._trail_reset_client = self.create_client(Empty, "/trail_layer/reset")
        self._trail_reset_attempts = 0
        self._trail_reset_timer = self.create_timer(1.0, self._reset_trail)
        self.declare_parameter("route_file", "")
        self.declare_parameter("frame_id", "map")
        self.declare_parameter("loop_route", False)
        self.declare_parameter("consecutive_failure_limit", 3)
        self.declare_parameter("route_check_period_sec", 1.0)
        self.declare_parameter("retry_delay_sec", 2.0)
        self.declare_parameter("cancel_timeout_sec", 2.0)
        self.declare_parameter(
            "scouting_state_file", "/tmp/bbiyong_scouting_session.json"
        )
        # A waypoint saved without a heading is inspected facing the nearest
        # structure within this radius, so the front camera frames the wall or
        # equipment instead of whatever direction map +X happens to be.
        self.declare_parameter("auto_yaw_search_radius_m", 1.2)
        self.declare_parameter("auto_yaw_occupied_threshold", 65)
        self.declare_parameter("map_topic", "/map")
        # (2026-08-07) collision_monitor's immediate_stop is an omnidirectional
        # 0.22 m hard stop (directional_approach is disabled), so any waypoint
        # placed closer than that to an obstacle can never actually be reached
        # or held -- the robot trips the safety stop the moment it arrives.
        # Reject such waypoints at route-load time with margin above 0.22 m
        # instead of discovering it mid-patrol.
        self.declare_parameter("min_waypoint_obstacle_clearance_m", 0.30)
        # --- 도착 후 방향 맞추기 (2026-08-10) ---
        # 도착 판정은 Nav2 쪽에서 계속 관대하게 둔다(yaw_goal_tolerance 6.28).
        # 방향은 도착한 뒤 이 노드가 Spin 액션으로 따로 맞춘다. 그래서 순찰
        # 웨이포인트마다 FollowWaypoints 목표를 하나씩 보낸다 - 목표가 살아 있는
        # 동안 Spin 을 걸면 controller_server 와 behavior_server 가 함께
        # /cmd_vel_nav 에 쓰기 때문이다.
        #
        # 허용 오차 0.524 rad = 30도. 카메라 화각이 있어 이 정도면 대상이
        # 화면에 들어온다 [사용자 결정 2026-08-10].
        self.declare_parameter("heading_tolerance_rad", 0.524)
        # 응시 시간. 방향을 맞춘 뒤(또는 포기한 뒤) 이만큼 정지해 있는다.
        self.declare_parameter("gaze_duration_sec", 5.0)
        # 회전 단계 전체의 상한. 8초로는 부족하다: 최악인 180도 회전만으로도
        # pi / min_rotational_vel = 3.1416 / 0.42 = 7.48 초가 들고, 여기에
        # 오차 재측정 후 보정 회전이 한 번 더 붙기 때문이다.
        self.declare_parameter("rotate_timeout_sec", 12.0)
        # 첫 회전 + 보정 회전. 무한정 매달리지 않는다.
        self.declare_parameter("rotate_max_attempts", 2)
        self.declare_parameter("pose_topic", "/amcl_pose")
        # 이보다 오래된 자세로는 각도 오차를 계산하지 않는다.
        self.declare_parameter("pose_max_age_sec", 5.0)

        self.route_file = Path(
            str(self.get_parameter("route_file").value)
        ).expanduser()
        self.frame_id = str(self.get_parameter("frame_id").value)
        self.loop_route = bool(self.get_parameter("loop_route").value)
        self.failure_limit = int(
            self.get_parameter("consecutive_failure_limit").value
        )
        check_period = float(
            self.get_parameter("route_check_period_sec").value
        )
        self.retry_delay = float(self.get_parameter("retry_delay_sec").value)
        self.cancel_timeout = float(
            self.get_parameter("cancel_timeout_sec").value
        )
        self.scouting_state_file = Path(
            str(self.get_parameter("scouting_state_file").value)
        ).expanduser()
        if (
            self.failure_limit <= 0
            or min(check_period, self.retry_delay, self.cancel_timeout) <= 0
        ):
            raise ValueError("route_file and positive patrol limits are required")

        status_qos = CONTROL_STATE_QOS
        self.state_publisher = self.create_publisher(
            String, "/bbiyong/patrol/state", status_qos
        )
        self.current_publisher = self.create_publisher(
            Int32, "/bbiyong/patrol/current_waypoint", status_qos
        )
        self.missed_publisher = self.create_publisher(
            Int32MultiArray, "/bbiyong/patrol/missed_waypoints", status_qos
        )
        self.estop_request_publisher = self.create_publisher(
            Bool, "/bbiyong/estop_request", 10
        )
        self.create_subscription(
            String, "/bbiyong/control_mode", self._on_mode, status_qos
        )
        self.create_subscription(Bool, "/bbiyong/estop", self._on_estop, status_qos)
        # The map provider latches, so a late subscriber still receives the
        # current grid rather than waiting for the next publish.
        self.create_subscription(
            OccupancyGrid,
            str(self.get_parameter("map_topic").value),
            self._on_map,
            QoSProfile(
                depth=1,
                durability=DurabilityPolicy.TRANSIENT_LOCAL,
                reliability=ReliabilityPolicy.RELIABLE,
            ),
        )
        self.create_subscription(
            PoseWithCovarianceStamped,
            str(self.get_parameter("pose_topic").value),
            self._on_pose,
            10,
        )
        self.action_client = ActionClient(self, FollowWaypoints, "/follow_waypoints")
        self.spin_client = ActionClient(self, Spin, "/spin")
        self.map = None
        self.auto_yaw_radius = float(
            self.get_parameter("auto_yaw_search_radius_m").value
        )
        self.auto_yaw_occupied = int(
            self.get_parameter("auto_yaw_occupied_threshold").value
        )
        self.waypoint_clearance_m = float(
            self.get_parameter("min_waypoint_obstacle_clearance_m").value
        )
        self.heading_tolerance = abs(
            float(self.get_parameter("heading_tolerance_rad").value)
        )
        self.gaze_duration = float(self.get_parameter("gaze_duration_sec").value)
        self.rotate_timeout = float(self.get_parameter("rotate_timeout_sec").value)
        self.rotate_max_attempts = int(
            self.get_parameter("rotate_max_attempts").value
        )
        self.pose_max_age = float(self.get_parameter("pose_max_age_sec").value)

        self.mode = "disabled"
        self.estop = True
        self.state = "IDLE"
        self.failure_reason = ""
        self.route = []
        self.pending_route = None
        self.route_mtime_ns = None
        self.goal_handle = None
        self.goal_response_future = None
        self.cancel_future = None
        self.active_indices = []
        self.resume_index = 0
        self.missed_indices = []
        self.consecutive_failures = 0
        self.shutdown_requested = False
        self.retry_not_before = 0.0
        self.cancel_deadline = None
        self.pending_cancel_reason = None
        self.route_session_id = None
        # 웨이포인트 하나씩 보내므로 진행 위치를 이 노드가 직접 들고 있는다.
        self.cursor = 0
        self.cycle_missed = []
        # "NAV"(이동 중) -> "ROTATE"(방향 맞추는 중) -> "GAZE"(응시 중) -> 다음
        self.phase = "NAV"
        self.target_heading = None
        self.heading_error = None
        self.heading_achieved = None
        self.rotate_attempts = 0
        self.rotate_deadline = None
        self.gaze_until = None
        self.spin_goal_handle = None
        self.spin_response_future = None
        self.pose_yaw = None
        self.pose_received_at = None
        self._reload_route(initial=True)
        self.create_timer(0.1, self._drive_state)
        self.create_timer(check_period, self._check_route_update)

    def _reset_trail(self) -> None:
        """경로 다양화 자취를 이번 실행분으로 비운다 (trail_layer)."""
        self._trail_reset_attempts += 1
        if self._trail_reset_client.service_is_ready():
            self._trail_reset_client.call_async(Empty.Request())
            self._trail_reset_timer.cancel()
            self.get_logger().info("Cleared the route-diversity trail")
        elif self._trail_reset_attempts >= 10:
            self._trail_reset_timer.cancel()
            self.get_logger().info(
                "trail_layer reset service never appeared; continuing")

    def _publish_state(self, state=None, reason=None):
        if state is not None:
            self.state = state
        if reason is not None:
            self.failure_reason = reason
        payload = {
            "state": self.state,
            "reason": self.failure_reason,
            "routeCount": len(self.route),
            "resumeIndex": self.resume_index,
            "missedWaypoints": self.missed_indices,
            # 추가 키다. state 문자열은 일부러 바꾸지 않았다 - 기존 소비자
            # (cloud_bridge -> FE)가 모르는 상태값을 만나지 않게 하기 위해서다.
            "phase": self.phase,
            "headingTargetRad": self.target_heading,
            "headingErrorRad": self.heading_error,
            "headingAchieved": self.heading_achieved,
        }
        self.state_publisher.publish(String(data=json.dumps(payload)))
        self.missed_publisher.publish(Int32MultiArray(data=self.missed_indices))

    def _reload_route(self, initial=False):
        try:
            route, document = load_route_document(self.route_file)
            mtime_ns = self.route_file.stat().st_mtime_ns
            session = read_ready_session(self.scouting_state_file)
            if not route_matches_session(document, session):
                raise ValueError("route must be reapplied for the active scouting map")
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            if initial:
                self._publish_state("FAILED", f"invalid route: {exc}")
            else:
                self.get_logger().error(f"ignored invalid route replacement: {exc}")
            return False
        clearance_error = self._validate_waypoint_clearance(route)
        if clearance_error is not None:
            if initial:
                self._publish_state("FAILED", clearance_error)
            else:
                self.get_logger().error(
                    f"ignored invalid route replacement: {clearance_error}"
                )
            return False
        self.route_mtime_ns = mtime_ns
        self.route_session_id = session["sessionId"]
        if self.goal_handle is not None or self.goal_response_future is not None:
            self.pending_route = route
            self.get_logger().info("validated route replacement; cancelling active goal")
            self._request_cancel("route replaced")
        else:
            self.route = route
            self.resume_index = 0
            self.missed_indices = []
            self._reset_cycle()
            self._publish_state("PAUSED" if initial else "IDLE", "")
        return True

    def _reset_cycle(self):
        """다음 _send_goal 이 순회 순서를 새로 짜도록 진행 상태를 비운다."""
        self.active_indices = []
        self.cursor = 0
        self.cycle_missed = []
        self._end_heading_phase()

    def _end_heading_phase(self):
        """회전/응시 단계를 접는다. 진행 중인 Spin 목표가 있으면 취소한다."""
        if self.spin_goal_handle is not None:
            self.spin_goal_handle.cancel_goal_async()
        self.spin_goal_handle = None
        self.spin_response_future = None
        self.phase = "NAV"
        self.target_heading = None
        self.rotate_deadline = None
        self.gaze_until = None
        self.rotate_attempts = 0

    def _check_route_update(self):
        try:
            mtime_ns = self.route_file.stat().st_mtime_ns
        except OSError:
            return
        if self.route_mtime_ns != mtime_ns:
            self._reload_route()

    def _on_mode(self, message):
        requested = message.data.strip().lower()
        if requested in {"disabled", "manual", "autonomy"}:
            self.mode = requested
        if requested != "autonomy":
            self._request_cancel("manual mode" if requested == "manual" else "disabled")

    def _on_estop(self, message):
        self.estop = bool(message.data)
        if self.estop:
            self._request_cancel("emergency stop")

    def _motion_allowed(self):
        return self.mode == "autonomy" and not self.estop and not self.shutdown_requested

    def _drive_state(self):
        if self.shutdown_requested:
            if self.goal_handle is None and self.goal_response_future is None:
                if rclpy.ok(context=self.context):
                    rclpy.shutdown(context=self.context)
            elif self.cancel_deadline is not None and time.monotonic() >= self.cancel_deadline:
                self.get_logger().error("patrol cancellation timed out during shutdown")
                if rclpy.ok(context=self.context):
                    rclpy.shutdown(context=self.context)
            return
        session = read_ready_session(self.scouting_state_file)
        if not session or session.get("sessionId") != self.route_session_id:
            if self.goal_handle is not None or self.goal_response_future is not None:
                self._request_cancel("scouting session changed")
            self._publish_state("WAITING_FOR_ROUTE", "reapply route for active map")
            return
        if (
            self.cancel_deadline is not None
            and time.monotonic() >= self.cancel_deadline
            and self.goal_handle is not None
        ):
            self.estop_request_publisher.publish(Bool(data=True))
            self.cancel_deadline = None
            self._publish_state("FAILED", "patrol cancellation timed out")
            return
        if (
            not self._motion_allowed()
            or self.state in {"FAILED", "COMPLETED"}
            or time.monotonic() < self.retry_not_before
        ):
            return
        if self.phase == "GAZE":
            if time.monotonic() >= self.gaze_until:
                self._advance_waypoint()
            return
        if self.phase == "ROTATE":
            self._tick_rotate()
            return
        if self.goal_handle is None and self.goal_response_future is None:
            self._send_goal()

    def _on_map(self, message):
        self.map = message

    def _on_pose(self, message):
        orientation = message.pose.pose.orientation
        # 평면 주행이라 yaw 만 필요하다. z/w 만으로 충분하지만 amcl 이 x/y 를
        # 정확히 0 으로 주지 않을 수 있어 일반식을 쓴다.
        self.pose_yaw = atan2(
            2.0 * (orientation.w * orientation.z + orientation.x * orientation.y),
            1.0 - 2.0 * (orientation.y * orientation.y
                         + orientation.z * orientation.z),
        )
        self.pose_received_at = time.monotonic()

    @staticmethod
    def _wrap_angle(value):
        """(-pi, pi] 로 접는다."""
        return (value + pi) % (2.0 * pi) - pi

    def _current_heading_error(self):
        """목표 방향까지 남은 각도. 자세를 모르면 None."""
        if self.target_heading is None:
            return None
        if self.pose_received_at is None:
            return None
        if time.monotonic() - self.pose_received_at > self.pose_max_age:
            return None
        return self._wrap_angle(self.target_heading - self.pose_yaw)

    def _needs_auto_yaw(self):
        return any(point.get("yaw") is None for point in self.route)

    def _nearest_structure_yaw(self, x, y):
        """Face the closest occupied cell, or None when nothing is in range."""
        grid = self.map
        if grid is None:
            return None
        resolution = grid.info.resolution
        if resolution <= 0.0:
            return None
        origin_x = grid.info.origin.position.x
        origin_y = grid.info.origin.position.y
        span = max(1, int(self.auto_yaw_radius / resolution))
        center_x = int((x - origin_x) / resolution)
        center_y = int((y - origin_y) / resolution)
        best = None
        best_distance = self.auto_yaw_radius
        for cell_y in range(max(0, center_y - span),
                            min(grid.info.height, center_y + span + 1)):
            row = cell_y * grid.info.width
            for cell_x in range(max(0, center_x - span),
                                min(grid.info.width, center_x + span + 1)):
                if grid.data[row + cell_x] < self.auto_yaw_occupied:
                    continue
                point_x = origin_x + (cell_x + 0.5) * resolution
                point_y = origin_y + (cell_y + 0.5) * resolution
                distance = hypot(point_x - x, point_y - y)
                if distance < best_distance:
                    best_distance = distance
                    best = (point_x, point_y)
        if best is None:
            return None
        return atan2(best[1] - y, best[0] - x)

    def _nearest_obstacle_distance(self, x, y, search_radius_m):
        """Distance to the nearest occupied cell within search_radius_m, or None."""
        grid = self.map
        if grid is None:
            return None
        resolution = grid.info.resolution
        if resolution <= 0.0:
            return None
        origin_x = grid.info.origin.position.x
        origin_y = grid.info.origin.position.y
        span = max(1, int(search_radius_m / resolution))
        center_x = int((x - origin_x) / resolution)
        center_y = int((y - origin_y) / resolution)
        best = search_radius_m
        found = False
        for cell_y in range(max(0, center_y - span),
                             min(grid.info.height, center_y + span + 1)):
            row = cell_y * grid.info.width
            for cell_x in range(max(0, center_x - span),
                                 min(grid.info.width, center_x + span + 1)):
                if grid.data[row + cell_x] < self.auto_yaw_occupied:
                    continue
                point_x = origin_x + (cell_x + 0.5) * resolution
                point_y = origin_y + (cell_y + 0.5) * resolution
                distance = hypot(point_x - x, point_y - y)
                if distance < best:
                    best = distance
                    found = True
        return best if found else None

    def _validate_waypoint_clearance(self, route):
        """Reject a route with a waypoint inside the safety-stop radius of an
        obstacle. Best-effort: without a map yet, clearance cannot be checked
        and the route is accepted (same fallback as auto-yaw resolution)."""
        if self.map is None:
            return None
        for index, point in enumerate(route):
            distance = self._nearest_obstacle_distance(
                point["x"], point["y"], self.waypoint_clearance_m
            )
            if distance is not None:
                return (
                    f"waypoint {index} at ({point['x']:.2f}, {point['y']:.2f}) is "
                    f"{distance:.2f}m from an obstacle; minimum clearance is "
                    f"{self.waypoint_clearance_m:.2f}m"
                )
        return None

    def _resolve_yaw(self, point):
        if point.get("yaw") is not None:
            return float(point["yaw"])
        yaw = self._nearest_structure_yaw(point["x"], point["y"])
        if yaw is None:
            self.get_logger().warning(
                f"no structure within {self.auto_yaw_radius:.2f} m of "
                f"({point['x']:.2f}, {point['y']:.2f}); keeping current heading"
            )
            return None  # None 반환 시 Nav2가 진입 진행 방향 유지
        return yaw

    @staticmethod
    def _explicit_yaw(point):
        """운영자가 실제로 지정한 방향만 돌려준다.

        _resolve_yaw 는 값이 없으면 지도에서 추정해 채워 넣는다. 그 추정값은
        도착 자세를 채우는 용도일 뿐이고(어차피 yaw_goal_tolerance 6.28 이라
        무시된다), 도착 후 회전 + 응시까지 시키지는 않는다. 그래야 방향을
        지정하지 않은 기존 경로가 예전과 똑같이 지나가기만 한다.
        """
        value = point.get("yaw")
        return None if value is None else float(value)

    def _pose_for(self, point):
        pose = PoseStamped()
        pose.header.frame_id = self.frame_id
        pose.header.stamp = self.get_clock().now().to_msg()
        pose.pose.position.x = point["x"]
        pose.pose.position.y = point["y"]
        yaw = self._resolve_yaw(point)
        if yaw is None:
            # yaw_quaternion(None) 은 ValueError 를 던진다. 방향을 모를 때는
            # 단위 사원수를 넣는다 - 도착 판정이 방향을 보지 않으므로
            # (yaw_goal_tolerance 6.28) 실제 주행에 영향이 없다.
            pose.pose.orientation.w = 1.0
        else:
            z, w = yaw_quaternion(yaw)
            pose.pose.orientation.z = z
            pose.pose.orientation.w = w
        return pose

    def _send_goal(self):
        if not self.route:
            self._publish_state("FAILED", "route is empty")
            return
        if not self.action_client.server_is_ready():
            self._publish_state("WAITING_FOR_NAV2", "follow_waypoints unavailable")
            return
        # Sending before the map arrives would bake map +X into every heading
        # that was left unspecified, and the goals are latched once dispatched.
        if self.map is None and self._needs_auto_yaw():
            self._publish_state("WAITING_FOR_MAP", "map unavailable for auto heading")
            return
        if not self.active_indices or self.cursor >= len(self.active_indices):
            self.active_indices = resume_order(
                len(self.route), self.resume_index, self.loop_route
            )
            self.cursor = 0
            self.cycle_missed = []
        if not self.active_indices:
            self._publish_state("FAILED", "route is empty")
            return
        index = self.active_indices[self.cursor]
        point = self.route[index]
        self.resume_index = index
        self.heading_error = None
        self.heading_achieved = None
        # 한 번에 웨이포인트 하나. 목표가 끝난 뒤에야 Spin 을 걸 수 있고,
        # 그래야 controller_server 와 behavior_server 가 /cmd_vel_nav 를
        # 동시에 쓰지 않는다.
        goal = FollowWaypoints.Goal()
        goal.poses = [self._pose_for(point)]
        self.current_publisher.publish(Int32(data=index))
        self._publish_state("STARTING", "")
        future = self.action_client.send_goal_async(
            goal, feedback_callback=self._on_feedback
        )
        self.goal_response_future = future
        future.add_done_callback(self._on_goal_response)

    def _on_goal_response(self, future):
        if future is not self.goal_response_future:
            return
        self.goal_response_future = None
        try:
            handle = future.result()
        except Exception as exc:
            self._record_failure(f"goal request failed: {exc}")
            return
        if not handle.accepted:
            self._record_failure("FollowWaypoints goal rejected")
            return
        self.goal_handle = handle
        self._publish_state("RUNNING", "")
        handle.get_result_async().add_done_callback(self._on_result)
        if self.pending_cancel_reason is not None:
            reason = self.pending_cancel_reason
            self.pending_cancel_reason = None
            self._request_cancel(reason)
        elif not self._motion_allowed():
            self._request_cancel("control changed before goal acceptance")

    def _on_feedback(self, _feedback_message):
        # 목표에 웨이포인트가 하나뿐이라 진행 위치는 전송 시점에 이미 확정돼
        # 있다. 피드백은 도달 순서를 알려줄 뿐이므로 여기서 할 일이 없다.
        return

    def _on_result(self, future):
        self.goal_handle = None
        self.cancel_future = None
        self.cancel_deadline = None
        self.pending_cancel_reason = None
        try:
            wrapped = future.result()
            missed = bool(getattr(wrapped.result, "missed_waypoints", []))
        except Exception as exc:
            self._record_failure(f"patrol result failed: {exc}")
            return
        if self.pending_route is not None:
            self.route = self.pending_route
            self.pending_route = None
            self.resume_index = 0
            self._reset_cycle()
            self._publish_state("IDLE", "")
            return
        if wrapped.status == GoalStatus.STATUS_CANCELED:
            self._end_heading_phase()
            self._publish_state("PAUSED", "patrol canceled")
            return
        if wrapped.status != GoalStatus.STATUS_SUCCEEDED:
            self._record_failure(f"patrol action status {wrapped.status}")
            return
        if self.cursor >= len(self.active_indices):
            # 결과가 오는 사이 순회 순서가 갈아엎였다. 다음 틱이 새로 보낸다.
            self._end_heading_phase()
            return
        index = self.active_indices[self.cursor]
        if missed:
            # 이 지점은 못 갔다. 방향을 맞출 대상이 아니므로 그냥 넘긴다.
            if index not in self.cycle_missed:
                self.cycle_missed.append(index)
            self.get_logger().warning(f"waypoint {index} was not reached; skipping")
            self._advance_waypoint()
            return
        self._begin_heading(index)

    def _begin_heading(self, index):
        """도착했다. 지정 방향이 있으면 회전 -> 응시, 없으면 바로 다음으로."""
        heading = self._explicit_yaw(self.route[index])
        if heading is None:
            self._advance_waypoint()
            return
        self.target_heading = self._wrap_angle(heading)
        self.phase = "ROTATE"
        self.rotate_attempts = 0
        self.rotate_deadline = time.monotonic() + self.rotate_timeout
        self.heading_achieved = None
        self._publish_state("RUNNING", "")
        self._send_spin()

    def _send_spin(self):
        """남은 각도만큼 Spin 을 건다. 더 돌 필요/여지가 없으면 응시로 넘어간다."""
        error = self._current_heading_error()
        self.heading_error = error
        if error is None:
            self.get_logger().warning(
                f"{self.pose_max_age:.1f}s 안에 들어온 자세가 없어 "
                f"waypoint {self.resume_index} 의 방향을 맞출 수 없다"
            )
            self._begin_gaze(False)
            return
        if abs(error) <= self.heading_tolerance:
            self._begin_gaze(True)
            return
        if self.rotate_attempts >= self.rotate_max_attempts:
            self.get_logger().warning(
                f"waypoint {self.resume_index}: 회전 {self.rotate_attempts}회 후에도 "
                f"오차 {error:.3f} rad 가 허용치 {self.heading_tolerance:.3f} rad 를 "
                f"넘는다; 그대로 진행한다"
            )
            self._begin_gaze(False)
            return
        if not self.spin_client.server_is_ready():
            self.get_logger().warning("spin 액션 서버가 없어 방향을 맞추지 못했다")
            self._begin_gaze(False)
            return
        remaining = max(1.0, self.rotate_deadline - time.monotonic())
        goal = Spin.Goal()
        # Spin 의 target_yaw 는 현재 자세 기준 상대 회전량이다.
        goal.target_yaw = float(error)
        goal.time_allowance = DurationMsg(sec=int(remaining))
        self.rotate_attempts += 1
        self.spin_response_future = self.spin_client.send_goal_async(goal)
        self.spin_response_future.add_done_callback(self._on_spin_response)

    def _on_spin_response(self, future):
        if future is not self.spin_response_future:
            return
        self.spin_response_future = None
        if self.phase != "ROTATE":
            return
        try:
            handle = future.result()
        except Exception as exc:
            self.get_logger().warning(f"spin 요청 실패: {exc}")
            self._begin_gaze(False)
            return
        if not handle.accepted:
            self.get_logger().warning("spin 목표가 거부됐다")
            self._begin_gaze(False)
            return
        self.spin_goal_handle = handle
        handle.get_result_async().add_done_callback(self._on_spin_result)

    def _on_spin_result(self, future):
        self.spin_goal_handle = None
        if self.phase != "ROTATE":
            return
        try:
            status = future.result().status
        except Exception as exc:
            self.get_logger().warning(f"spin 결과 실패: {exc}")
            self._begin_gaze(False)
            return
        if status not in (GoalStatus.STATUS_SUCCEEDED, GoalStatus.STATUS_ABORTED):
            # 취소됨 - 순찰 자체가 멈춘 상황이다. _request_cancel 이 정리한다.
            return
        if status == GoalStatus.STATUS_ABORTED:
            # 회전 경로에 장애물이 예측되면 Spin 이 스스로 포기한다
            # (behavior_server simulate_ahead_time 2.0).
            self.get_logger().warning(
                f"waypoint {self.resume_index}: spin 중단(장애물 예측 또는 시간 초과)"
            )
        # 실제로 얼마나 돌았는지 다시 재고, 필요하면 한 번 더 보정한다.
        self._send_spin()

    def _tick_rotate(self):
        if time.monotonic() < self.rotate_deadline:
            return
        self.get_logger().warning(
            f"waypoint {self.resume_index}: 방향 맞추기 {self.rotate_timeout:.1f}s "
            f"초과; 그대로 진행한다"
        )
        if self.spin_goal_handle is not None:
            self.spin_goal_handle.cancel_goal_async()
            self.spin_goal_handle = None
        self.spin_response_future = None
        self._begin_gaze(False)

    def _begin_gaze(self, achieved):
        self.phase = "GAZE"
        self.heading_achieved = bool(achieved)
        self.heading_error = self._current_heading_error()
        self.gaze_until = time.monotonic() + self.gaze_duration
        self.rotate_deadline = None
        self._publish_state("RUNNING", "")

    def _advance_waypoint(self):
        self._end_heading_phase()
        self.cursor += 1
        if self.cursor < len(self.active_indices):
            self._publish_state("RUNNING", "")
            return
        self._finish_cycle()

    def _finish_cycle(self):
        missed = sorted(set(self.cycle_missed))
        self.missed_indices = missed
        self.active_indices = []
        self.cursor = 0
        self.cycle_missed = []
        if missed:
            self.consecutive_failures += 1
            if self.consecutive_failures >= self.failure_limit:
                self._publish_state(
                    "FAILED",
                    f"missed waypoints for {self.consecutive_failures} cycles",
                )
                return
        else:
            self.consecutive_failures = 0
        self.resume_index = 0
        if self.loop_route and self._motion_allowed():
            self._publish_state("IDLE", "")
        else:
            self._publish_state("COMPLETED", "")

    def _record_failure(self, reason):
        self.goal_handle = None
        self.goal_response_future = None
        self.consecutive_failures += 1
        self.retry_not_before = time.monotonic() + self.retry_delay
        state = "FAILED" if self.consecutive_failures >= self.failure_limit else "BLOCKED"
        self._publish_state(state, reason)

    def _request_cancel(self, reason):
        if self.phase in {"ROTATE", "GAZE"}:
            # 회전/응시 중에는 FollowWaypoints 목표가 이미 끝나 있다. 진행 중인
            # Spin 만 접으면 된다. cursor 는 그대로 둬서 재개하면 같은 지점을
            # 다시 도착 처리하고 방향을 다시 맞춘다.
            self._end_heading_phase()
        if self.goal_handle is None:
            if self.goal_response_future is not None:
                self.pending_cancel_reason = reason
                self._publish_state("PAUSING", reason)
            else:
                self._publish_state("PAUSED", reason)
            return
        if self.cancel_future is not None:
            return
        self._publish_state("PAUSING", reason)
        self.cancel_deadline = time.monotonic() + self.cancel_timeout
        self.cancel_future = self.goal_handle.cancel_goal_async()
        self.cancel_future.add_done_callback(self._on_cancel_response)

    def _on_cancel_response(self, future):
        try:
            response = future.result()
            if not response.goals_canceling:
                self.get_logger().error("Nav2 did not acknowledge patrol cancellation")
        except Exception as exc:
            self.get_logger().error(f"patrol cancellation failed: {exc}")

    def request_shutdown(self):
        if self.shutdown_requested:
            return
        self.shutdown_requested = True
        self.cancel_deadline = time.monotonic() + self.cancel_timeout
        self.estop_request_publisher.publish(Bool(data=True))
        self._request_cancel("mission shutdown")


def main(args=None):
    rclpy.init(args=args)
    node = PatrolRoute()

    def stop_handler(_signum, _frame):
        node.request_shutdown()

    previous_handlers = {}
    for signum in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signum] = signal.signal(signum, stop_handler)
    try:
        rclpy.spin(node)
    finally:
        node.request_shutdown()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()


if __name__ == "__main__":
    main()
