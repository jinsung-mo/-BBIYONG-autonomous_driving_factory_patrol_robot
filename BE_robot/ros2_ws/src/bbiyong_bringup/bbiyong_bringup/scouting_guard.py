#!/usr/bin/env python3
"""Fail-closed readiness and authority guard for saved-map scouting."""

from __future__ import annotations

import math
import json
from pathlib import Path
import time
import uuid

from geometry_msgs.msg import PoseWithCovarianceStamped
from lifecycle_msgs.srv import GetState
import rclpy
from rclpy.duration import Duration
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from rclpy.time import Time
from std_msgs.msg import Bool, Empty, String
from tf2_msgs.msg import TFMessage
from sensor_msgs.msg import LaserScan
from tf2_ros import Buffer, TransformListener

from .scouting_session import atomic_write_json


LIFECYCLE_NODES = (
    "map_server",
    "amcl",
    "controller_server",
    "planner_server",
    "behavior_server",
    "bt_navigator",
    "waypoint_follower",
    "velocity_smoother",
    # collision_slowdown_monitor 는 2026-08-07 에 런치에서 제거됐다 —
    # slowdown_zone 이 enabled:false 라 하는 일이 없는데 명령 체인에서 가장 느린
    # 단이었다(전체 182.7ms 중 86.9ms). 여기 남아 있으면 그 노드의 get_state 가
    # 영원히 응답하지 않아 guard 가 계속 DEGRADED(ready=false) 가 되고,
    # navigation_orchestrator._navigation_ready() 가 항상 실패해
    # **순찰이 절대 시작되지 않는다**. 노드 제거의 후속 누락이었다.
    # 되살릴 때는 navigation_core.launch.py 의 노드 복원과 함께 이 줄도 되돌릴 것.
    "collision_monitor",
)

# Topic an operator publishes to in order to clear a latched FAILED state.
# A topic rather than a service on purpose: the failure this guard now has to
# survive is *service replies being lost under CPU load*, so the recovery path
# must not itself be a service call. Matches the existing
# bbiyong_base/escape_recovery.py:125 pattern (`/escape/request`, std_msgs/Empty).
REARM_TOPIC = "/scouting/rearm"


class ScoutingGuard(Node):
    def __init__(self):
        super().__init__("bbiyong_scouting_guard")
        self.declare_parameter("map_file", "")
        self.declare_parameter("state_file", "/tmp/bbiyong_scouting_session.json")
        self.declare_parameter("readiness_timeout_sec", 90.0)
        self.declare_parameter("authority_settle_sec", 2.0)
        # Losing a condition for a single tick is normal while Nav2 is driving:
        # the lifecycle poll is ten service calls and any one of them can miss a
        # round. Only a sustained loss is real, and treating a blip as real
        # e-stops the robot mid-patrol (observed 17:27:40, patrol paused at
        # waypoint 3).
        self.declare_parameter("readiness_loss_grace_sec", 5.0)
        # --- 2026-08-07: service-response loss (probe hardening) ---------------
        # Under CPU saturation (6-core load 9.9, camera_node doing x264 in
        # software) rclcpp drops the *reply* to an already-served request:
        #   "failed to send response to /collision_slowdown_monitor/get_state
        #    (timeout)".
        # The old code kept the call_async future forever ("if not future.done():
        # continue"), so one lost reply blocked every later probe for that node
        # for the life of the process. The node stayed active [3] the whole
        # time -- the guard simply never asked again, then declared it inactive
        # at the 90 s timeout and latched a failure with an e-stop.
        # Same family of failure the same day: /map_server/change_state (map
        # save), /calib/planner_server/change_state (calibration) and
        # /amcl/change_state (the failed guard restart that took localization
        # down entirely). The calibration script already works around it by
        # polling get_state instead of trusting the acknowledgement
        # (~/calib/calibrate_trail.py state_is(), S15P11E101-799).
        #
        # How long to wait for one get_state reply before abandoning it and
        # asking again. 3.0 s is ~12 guard ticks; the observed reply latency
        # even under the 9.9 load was well under 1 s when a reply arrived at
        # all, so a miss at 3 s is a genuinely lost reply, not slowness.
        self.declare_parameter("lifecycle_probe_timeout_sec", 3.0)
        # How many probes in a row must be lost before we admit we no longer
        # know the node's state. One lost reply is a symptom of CPU load, not
        # of a dead node, so a single miss must never be treated as "inactive".
        self.declare_parameter("lifecycle_probe_miss_limit", 3)
        # Optional upper bound on how long a DEGRADED (probe-only) condition may
        # persist while already READY before it is escalated to a real failure.
        # 0.0 = no limit, which is the decided default: a probe failure is a
        # statement about our own ability to measure, never about the robot, so
        # it must not e-stop and must recover automatically however long it
        # lasts. Set > 0 only if you want a driving robot to stop after being
        # unable to reach the lifecycle services for that long.
        # 60s, not 0 (unlimited).  Probes retry every ~3s, so an unbroken 60s
        # of silence is not "the CPU was briefly busy" -- it means the guard has
        # been blind for 20 consecutive attempts while the robot is driving.
        # Riding that out indefinitely would mean patrolling with no supervision
        # at all, which is the failure mode this node exists to prevent.
        # Set to 0.0 to disable the escalation.  [2026-08-07]
        self.declare_parameter("probe_degraded_max_sec", 60.0)
        # Whether a DEGRADED condition that starts *after* the guard was already
        # READY keeps ready=true (patrol in flight is not interrupted) or drops
        # to ready=false (patrol stalls until probes recover). Before the first
        # READY the answer is always false -- you cannot be ready without ever
        # having been ready. See CHANGES.md section 6 for the trade-off.
        self.declare_parameter("degraded_keeps_ready", True)
        # ----------------------------------------------------------------------
        # Break the stationary deadlock: AMCL only publishes /amcl_pose after
        # ~0.10 m of motion, but motion needs patrol, and patrol needs this
        # guard to be ready. Re-publishing the pose saved with the map makes
        # AMCL emit one without the robot moving.
        self.declare_parameter("seed_initial_pose", True)
        self.declare_parameter(
            "initial_pose_hint_file", "~/.local/state/bbiyong/initial_pose.json"
        )
        self.declare_parameter("seed_after_sec", 5.0)
        self.map_file = str(Path(str(self.get_parameter("map_file").value)).expanduser())
        self.state_file = Path(str(self.get_parameter("state_file").value)).expanduser()
        self.timeout = float(self.get_parameter("readiness_timeout_sec").value)
        self.settle = float(self.get_parameter("authority_settle_sec").value)
        self.loss_grace = float(
            self.get_parameter("readiness_loss_grace_sec").value
        )
        self.probe_timeout = float(
            self.get_parameter("lifecycle_probe_timeout_sec").value
        )
        self.probe_miss_limit = max(
            1, int(self.get_parameter("lifecycle_probe_miss_limit").value)
        )
        self.probe_degraded_max = float(
            self.get_parameter("probe_degraded_max_sec").value
        )
        self.degraded_keeps_ready = bool(
            self.get_parameter("degraded_keeps_ready").value
        )
        self.seed_enabled = bool(self.get_parameter("seed_initial_pose").value)
        self.hint_file = Path(
            str(self.get_parameter("initial_pose_hint_file").value)
        ).expanduser()
        self.seed_after = float(self.get_parameter("seed_after_sec").value)
        self.lost_since = None
        self.seeded = False
        if not self.map_file or min(self.timeout, self.settle) <= 0.0:
            raise ValueError("map_file and positive readiness limits are required")
        if self.probe_timeout <= 0.0:
            raise ValueError("lifecycle_probe_timeout_sec must be positive")

        self.session_id = uuid.uuid4().hex
        self.started = time.monotonic()
        self.ready_since = None
        self.ready = False
        self.failed = False
        self.failed_reason = ""
        self.last_heartbeat = 0.0
        self.pose_valid = False
        self.map_odom_last_seen = None
        # self.lifecycle[name] is the last state a node actually *told* us.
        # It only ever changes on a successful reply -- a lost reply no longer
        # writes False here (2026-08-07: that write was the misdiagnosis).
        self.lifecycle = {name: False for name in LIFECYCLE_NODES}
        # lifecycle_answered[name]: do we currently have a trustworthy answer?
        # False at startup (fail-closed: no answer means not ready) and again
        # after probe_miss_limit consecutive lost/failed probes.
        self.lifecycle_answered = {name: False for name in LIFECYCLE_NODES}
        # Consecutive lost/failed probes per node; reset to 0 by any reply.
        self.probe_misses = {name: 0 for name in LIFECYCLE_NODES}
        self.lifecycle_futures = {}
        # Monotonic time each in-flight request was issued, so a reply that
        # never comes back can be abandoned instead of blocking forever.
        self.lifecycle_requested_at = {}
        # When the readiness picture first went bad for probe-only reasons.
        self.degraded_since = None
        self.last_degraded_log = 0.0
        # True between a re-arm and the next READY. While set, any *real*
        # missing condition fails immediately instead of waiting out the 90 s
        # readiness window: a re-arm means "judge me again", not "assume I am
        # fine now".
        self.rearm_verify = False
        self.rearm_count = 0
        self.lifecycle_clients = {
            name: self.create_client(GetState, f"/{name}/get_state")
            for name in LIFECYCLE_NODES
        }
        self.ready_publisher = self.create_publisher(
            Bool, "/bbiyong/scouting/ready", 10
        )
        self.state_publisher = self.create_publisher(
            String, "/bbiyong/scouting/state", 10
        )
        self.estop_request_publisher = self.create_publisher(
            Bool, "/bbiyong/estop_request", 10
        )
        self.initial_pose_publisher = self.create_publisher(
            PoseWithCovarianceStamped, "/initialpose", 10
        )
        self.create_subscription(
            PoseWithCovarianceStamped,
            "/amcl_pose",
            self._on_pose,
            qos_profile_sensor_data,
        )
        self.create_subscription(TFMessage, "/tf", self._on_tf, qos_profile_sensor_data)
        # [2026-08-08] 충돌 감시의 **유일한 입력**을 가드도 지켜본다.
        # 12:32 순찰의 앞 280초(45%) 동안 safety_body_filter 가 죽어 있었고
        # collision_monitor 는 "Ignoring the source" 를 24,912회 찍으며 그냥 통과시켰다.
        # 가드는 그때 READY 였다 — 이 필터는 라이프사이클 노드가 아니라
        # _lifecycle_all_ready() 에 안 잡히기 때문이다.
        self.safety_scan_last_seen = None
        # [2026-08-08] 스스로 해소된 실패의 제한적 자동 재무장 (무인 운용용).
        # respawn 이 붙은 뒤로는 실패 원인이 사람 없이 사라지는 경우가 생긴다.
        self.auto_rearm_budget = 3
        self.auto_rearm_clean_since = None
        self.create_subscription(
            LaserScan, "/scan_safety_body",
            self._on_safety_scan, qos_profile_sensor_data,
        )
        self.create_subscription(Empty, REARM_TOPIC, self._on_rearm, 10)
        self.tf_buffer = Buffer()
        self.tf_listener = TransformListener(self.tf_buffer, self)
        self._persist("WAITING", "initial pose and authorities are not ready")
        self.create_timer(0.25, self._tick)

    def _payload(self, state, reason):
        return {
            "schemaVersion": 1,
            "sessionId": self.session_id,
            "mapFile": self.map_file,
            "ready": self.ready,
            "state": state,
            "reason": reason,
            "updatedAt": time.time(),
        }

    def _persist(self, state, reason):
        payload = self._payload(state, reason)
        atomic_write_json(self.state_file, payload)
        try:
            self.ready_publisher.publish(Bool(data=self.ready))
            self.state_publisher.publish(String(data=json.dumps(payload)))
        except Exception:
            # The atomic state file is authoritative during context shutdown.
            pass

    def _on_pose(self, message):
        values = [
            message.pose.pose.position.x,
            message.pose.pose.position.y,
            message.pose.pose.orientation.x,
            message.pose.pose.orientation.y,
            message.pose.pose.orientation.z,
            message.pose.pose.orientation.w,
            *message.pose.covariance,
        ]
        orientation = message.pose.pose.orientation
        quaternion_norm = math.sqrt(
            orientation.x ** 2
            + orientation.y ** 2
            + orientation.z ** 2
            + orientation.w ** 2
        )
        self.pose_valid = (
            all(math.isfinite(value) for value in values)
            and quaternion_norm > 0.5
        )

    def _on_safety_scan(self, _message):
        """충돌 감시가 실제로 스캔을 받고 있는지의 유일한 증거."""
        self.safety_scan_last_seen = time.monotonic()

    def _on_tf(self, message):
        # rclpy delivers only the message to a subscription callback, so the
        # publisher GID this once keyed on is not available.  Asking for it
        # raised TypeError on the first /tf message and killed the executor,
        # which is why the readiness file was never produced.  Track liveness
        # instead; a second map->odom authority is caught by the slam_toolbox
        # check in _tick, which is the case this guard actually protects.
        now = time.monotonic()
        for transform in message.transforms:
            parent = transform.header.frame_id.lstrip("/")
            child = transform.child_frame_id.lstrip("/")
            if parent == "map" and child == "odom":
                self.map_odom_last_seen = now

    # --- operator re-arm -----------------------------------------------------

    def _on_rearm(self, _message):
        """Clear a latched FAILED state on explicit operator request.

        Patch D (2026-08-07). _fail() no longer calls rclpy.shutdown(), so the
        node is still alive and still observing when this arrives; re-arming is
        a state reset, not a restart. That matters because the only previous
        way out of FAILED was restarting the whole localization stack, and on
        2026-08-07 that restart itself failed (/amcl/change_state reply lost),
        tearing down map_server and amcl and losing localization entirely.

        A re-arm means "judge the conditions again", NOT "the conditions are
        fine now". If something real is still broken, _tick() fails again on the
        very next pass (self.rearm_verify). There is no automatic re-arm: a
        latched FAILED stays latched until a human publishes here.

        This deliberately does NOT publish estop_request=False. See the note in
        _fail() -- that message would be silently discarded anyway.
        """
        if not self.failed:
            self.get_logger().info("re-arm ignored: guard is not in FAILED")
            return
        now = time.monotonic()
        self.rearm_count += 1
        previous_session = self.session_id
        previous_reason = self.failed_reason
        self.failed = False
        self.failed_reason = ""
        self.ready = False
        self.ready_since = None
        self.lost_since = None
        self.degraded_since = None
        self.rearm_verify = True
        # Force every lifecycle node to prove itself again before we call the
        # session ready. Fail-closed: a stale "it was active before the failure"
        # must not carry across a re-arm.
        self.probe_misses = {name: 0 for name in LIFECYCLE_NODES}
        self.lifecycle_answered = {name: False for name in LIFECYCLE_NODES}
        for name in list(self.lifecycle_futures):
            self._abandon_request(name)
        # Restart the readiness window, otherwise the 90 s timeout would fire on
        # the very next tick. Real conditions are still checked immediately via
        # rearm_verify; this window only covers waiting for probe answers.
        self.started = now
        # Deliberately NOT resetting self.seeded: re-seeding would republish the
        # map's saved initial pose, teleporting AMCL back to the map origin pose
        # even though the robot has since moved.
        #
        # A new sessionId, always. A re-arm means localization authority was
        # distrusted and then restored, and route_matches_session() exists
        # precisely so a route built before that break is not silently reused
        # after it.
        self.session_id = uuid.uuid4().hex
        self.get_logger().info(
            f"re-arm #{self.rearm_count} accepted via {REARM_TOPIC}; "
            f"cleared FAILED ({previous_reason}); "
            f"sessionId {previous_session} -> {self.session_id}; "
            "THE PATROL ROUTE MUST BE REAPPLIED before patrol will start; "
            "e-stop is NOT released by this node"
        )
        self._persist(
            "WAITING",
            f"re-armed via {REARM_TOPIC}; reapply the patrol route",
        )

    # --- lifecycle probing ---------------------------------------------------
    # Patch A + B (2026-08-07): every in-flight get_state request now carries a
    # deadline and is re-issued when it expires, and a node is only believed to
    # be gone after several consecutive misses.

    def _note_probe_miss(self, name, why):
        """Record one lost/failed probe for `name`.

        A single miss deliberately does NOT change self.lifecycle: on
        2026-08-07 collision_slowdown_monitor was continuously active [3] while
        its get_state replies were being dropped by the saturated CPU, and the
        old code's `self.lifecycle[name] = False` on that path is exactly what
        produced the false "inactive lifecycle nodes=..." verdict.
        """
        self.probe_misses[name] = self.probe_misses.get(name, 0) + 1
        if self.probe_misses[name] >= self.probe_miss_limit:
            # Repeated misses: we genuinely no longer know. Fail closed for
            # readiness, but this is reported as a *probe* problem, not as
            # "the node is inactive" -- see _missing_conditions().
            self.lifecycle_answered[name] = False
            self.get_logger().debug(
                f"{name}/get_state unanswered x{self.probe_misses[name]} ({why})"
            )

    def _abandon_request(self, name):
        """Drop an in-flight request so the next tick can issue a fresh one."""
        future = self.lifecycle_futures.pop(name, None)
        self.lifecycle_requested_at.pop(name, None)
        if future is None:
            return
        client = self.lifecycle_clients.get(name)
        try:
            future.cancel()
        except Exception:
            pass
        # rclpy keeps a pending-request entry per call_async; without this the
        # abandoned sequence numbers accumulate for the life of the process.
        if client is not None and hasattr(client, "remove_pending_request"):
            try:
                client.remove_pending_request(future)
            except Exception:
                pass

    def _request_lifecycle_states(self):
        now = time.monotonic()
        for name, client in self.lifecycle_clients.items():
            future = self.lifecycle_futures.get(name)
            if future is not None and not future.done():
                issued = self.lifecycle_requested_at.get(name, now)
                if now - issued < self.probe_timeout:
                    continue
                # Deadline blown -- this is the 2026-08-07 case: the service
                # served the request and then failed to send the response, so
                # the future will never complete. Throw it away and re-ask,
                # instead of blocking this node's probe forever.
                self._abandon_request(name)
                self._note_probe_miss(name, "reply deadline expired")
            if not client.service_is_ready():
                # Discovery lag is also just a missed probe, not evidence that
                # the node is inactive. Previously this wrote False directly.
                self._note_probe_miss(name, "service not discovered")
                continue
            future = client.call_async(GetState.Request())
            self.lifecycle_futures[name] = future
            self.lifecycle_requested_at[name] = now
            future.add_done_callback(
                lambda completed, node_name=name: self._on_lifecycle(node_name, completed)
            )

    def _on_lifecycle(self, name, future):
        try:
            active = future.result().current_state.label == "active"
        except Exception:
            # The call completed but errored (service gone, type mismatch).
            # Still only a miss: let the counter decide whether it is real.
            self._note_probe_miss(name, "call raised")
        else:
            # A real answer, even a late one, is authoritative.
            self.lifecycle[name] = active
            self.lifecycle_answered[name] = True
            self.probe_misses[name] = 0
        finally:
            # Only clear the slot if this is still the request we are tracking;
            # a late reply to an abandoned request must not delete a newer
            # in-flight request.
            if self.lifecycle_futures.get(name) is future:
                self.lifecycle_futures.pop(name, None)
                self.lifecycle_requested_at.pop(name, None)

    def _lifecycle_all_ready(self):
        """Every node has told us, recently, that it is active."""
        return all(
            self.lifecycle_answered[name] and self.lifecycle[name]
            for name in LIFECYCLE_NODES
        )

    def _lifecycle_inactive(self):
        """Nodes that answered and said they are NOT active. A real problem."""
        return [
            name for name in LIFECYCLE_NODES
            if self.lifecycle_answered[name] and not self.lifecycle[name]
        ]

    def _lifecycle_unanswered(self):
        """Nodes we could not reach. A probe problem, not a node problem."""
        return [name for name in LIFECYCLE_NODES if not self.lifecycle_answered[name]]

    # -------------------------------------------------------------------------

    def _fail(self, reason, estop=True):
        """Latch a terminal failure -- but stay alive.

        Patch C + D (2026-08-07). Two changes from the original:

        1. `estop` is explicit. Only a genuine authority or localization hazard
           justifies yanking the brake; being unable to *ask* a node its state
           never reaches here at all.
        2. rclpy.shutdown() is GONE. Killing the context made the only recovery
           path a full localization restart, and on 2026-08-07 that restart
           itself failed (the /amcl/change_state reply was lost), so the wrapper
           tore down map_server and amcl and localization vanished entirely.
           Pulling the main breaker to reset one switch. The node now keeps
           ticking, keeps the state file fresh, keeps observing, and waits for
           an operator re-arm on REARM_TOPIC.

           Note also that the old shutdown did not even produce a clean death:
           on 2026-08-07 pid 17168 stayed alive for 28 minutes after
           rclpy.shutdown() and ignored SIGTERM, needing kill -9. The previous
           structure produced a zombie, not an exit.

        Staying alive does NOT soften the failure: ready stays false and
        estop_request is still published. A live process is not restored
        authority.

        We never publish estop_request=False anywhere. This node can request a
        stop but must not release one -- and the request would be discarded in
        any case: control_state_bridge._on_estop_request()
        (bbiyong_base/control_state_bridge.py:118-119) returns immediately on a
        False payload. Releasing e-stop goes through the control-state path
        (control file / set_autonomy), owned by control_state_bridge, which is
        the sole publisher of the latched /bbiyong/estop that cmd_mux and the
        drive adapters obey.
        """
        if self.failed:
            return
        self.failed = True
        self.failed_reason = reason
        self.ready = False
        self.rearm_verify = False
        if estop:
            self.estop_request_publisher.publish(Bool(data=True))
        self._persist("FAILED", reason)
        self.get_logger().error(
            f"{reason} -- latched FAILED; re-arm with: "
            f"ros2 topic pub --once {REARM_TOPIC} std_msgs/msg/Empty {{}}"
        )

    def _failed_tick(self, now, real_missing, probe_missing):
        """Keep the FAILED session observable and, above all, CURRENT.

        Patch D. Two reasons this exists:

        1. Consumers key on `updatedAt` freshness, so a latched guard that
           stopped writing looks identical to a crashed one.
        2. The original wrote the failure reason once and died, so the screen
           kept showing the first-observed cause forever and there was no way to
           tell which conditions were still broken -- on 2026-08-07 that meant
           running `ros2 lifecycle get` by hand on each node. The reason field
           now carries the *live* picture next to the latched cause.

        ready stays false throughout; only an operator re-arm clears FAILED.
        """
        self.ready = False
        current = real_missing + probe_missing

        # [2026-08-08] 조건이 스스로 깨끗해졌으면 제한적으로 자동 재무장한다.
        # 무제한이 아니다: 모든 조건이 깨끗 + 연속 8초 유지 + 세션당 3회.
        # respawn 덕분에 원인이 사람 없이 사라지는 경우가 실제로 생기는데,
        # 그때까지 사람을 기다리는 것은 안전이 아니라 그냥 정지다.
        # (사람이 치워야 하는 위험 — 예: slam_toolbox 이중 권한 — 은 저절로
        #  사라지지 않으므로 '모든 조건 깨끗' 에서 자동으로 걸러진다)
        if current:
            self.auto_rearm_clean_since = None
        else:
            if self.auto_rearm_clean_since is None:
                self.auto_rearm_clean_since = now
            elif (now - self.auto_rearm_clean_since >= 8.0
                    and self.auto_rearm_budget > 0):
                self.auto_rearm_budget -= 1
                self.get_logger().warning(
                    "scouting auto re-arm: every condition has been healthy for "
                    "8s (was: %s); %d auto re-arm(s) left this session"
                    % (self.failed_reason, self.auto_rearm_budget)
                )
                self.failed = False
                self.failed_reason = ""
                self.rearm_verify = True
                self.ready_since = None
                self.lost_since = None
                self.degraded_since = None
                self.auto_rearm_clean_since = None
                self._persist("WAITING", "auto re-armed after conditions cleared")
                return

        live = "; ".join(current) if current else "all conditions healthy"
        if now - self.last_heartbeat >= 1.0:
            self.last_heartbeat = now
            self._persist(
                "FAILED", f"{self.failed_reason} | now: {live}"
            )

    def _degrade(self, reason, now, keep_ready):
        """Report 'we cannot currently tell' without latching a failure.

        Patch C + D (2026-08-07). DEGRADED is a new value of the `state` field
        only. Every consumer of the session file keys on the `ready` boolean
        (scouting_session.read_ready_session, navigation_orchestrator.
        _scouting_session), never on `state`, so adding this value is backward
        compatible: readers see exactly the readiness the `ready` flag states.
        The node stays alive and keeps re-probing instead of latching, which is
        what made the 2026-08-07 refusal permanent. Recovery is automatic and
        unlimited: the moment the replies come back, the normal READY path takes
        over on its own.
        """
        if self.degraded_since is None:
            self.degraded_since = now
        self.ready = bool(keep_ready)
        if now - self.last_degraded_log >= 10.0:
            self.last_degraded_log = now
            self.get_logger().warning(
                f"scouting DEGRADED for {now - self.degraded_since:.0f}s "
                f"(retrying, ready={self.ready}): {reason}"
            )
        if now - self.last_heartbeat >= 1.0:
            self.last_heartbeat = now
            self._persist("DEGRADED", reason)

    def _seed_initial_pose(self, now):
        """Publish the pose saved with this map so AMCL emits an /amcl_pose.

        Done once, and only for a hint that belongs to the map being localized
        against -- seeding from another map's pose would place the robot
        somewhere it is not.
        """
        if self.pose_valid or not self.seed_enabled:
            return
        # Wait for the initial seed_after_sec, then retry every 5s if still invalid
        if now - self.started < self.seed_after:
            return
        # If we already seeded recently, wait 5s before retrying
        if getattr(self, '_last_seed_attempt', 0) and now - getattr(self, '_last_seed_attempt', 0) < 5.0:
            return
            
        self._last_seed_attempt = now
        self.seeded = True
        try:
            hint = json.loads(self.hint_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            self.get_logger().warning(
                f"no usable initial-pose hint at {self.hint_file}: {exc}; "
                "drive the robot ~20 cm so AMCL publishes"
            )
            return
        expected = Path(self.map_file).name
        if hint.get("map_yaml") != expected:
            self.get_logger().warning(
                f"initial-pose hint is for {hint.get('map_yaml')}, "
                f"localizing against {expected}; not seeding"
            )
            return
        try:
            x = float(hint["x"])
            y = float(hint["y"])
            yaw = float(hint["yaw"])
        except (KeyError, TypeError, ValueError) as exc:
            self.get_logger().warning(f"malformed initial-pose hint: {exc}")
            return
        message = PoseWithCovarianceStamped()
        message.header.frame_id = "map"
        message.header.stamp = self.get_clock().now().to_msg()
        message.pose.pose.position.x = x
        message.pose.pose.position.y = y
        message.pose.pose.orientation.z = math.sin(yaw / 2.0)
        message.pose.pose.orientation.w = math.cos(yaw / 2.0)
        covariance = [0.0] * 36
        covariance[0] = covariance[7] = 0.05
        covariance[35] = 0.02
        message.pose.covariance = covariance
        self.initial_pose_publisher.publish(message)
        self.get_logger().info(
            f"seeded AMCL from {self.hint_file.name}: "
            f"({x:.3f}, {y:.3f}, yaw {yaw:.3f})"
        )

    def _safety_scan_live(self, limit=3.0):
        """충돌 감시 입력이 살아 있는가. 한 번도 못 받았으면 살아 있지 않다."""
        if self.safety_scan_last_seen is None:
            return False
        return (time.monotonic() - self.safety_scan_last_seen) <= limit

    def _missing_conditions(self, publishers, map_odom_live, transform_ready):
        """Split what is wrong into 'real hazard' and 'could not ask'.

        Patch C (2026-08-07). Everything except an unreachable lifecycle
        service is a real observation: we saw the /map publisher list, we saw
        (or did not see) the TF, we saw the pose, the node answered and said it
        was not active. Only "the get_state reply never came back" is a
        statement about our own ability to measure, and that is the one that
        must not e-stop the robot or latch a failure.
        """
        real = []
        probe = []
        if len(publishers) != 1 or (
            publishers and publishers[0].node_name.lstrip("/") != "map_server"
        ):
            owners = [publisher.node_name for publisher in publishers]
            real.append(f"/map publishers={owners}")
        if not map_odom_live:
            real.append("recent map->odom TF")
        if not self.pose_valid:
            real.append("valid /amcl_pose")
        if not transform_ready:
            real.append("map->base_link TF")
        # [2026-08-08] /scan_safety_body 는 약 12Hz 다. 3초 넘게 끊기면
        # collision_monitor 가 눈을 감은 것이므로 실제 위험으로 분류한다
        # (real -> estop 대상). 오늘 이게 없어서 280초를 무방비로 달렸다.
        if not self._safety_scan_live():
            real.append("collision monitor input (/scan_safety_body)")
        inactive = self._lifecycle_inactive()
        if inactive:
            real.append("inactive lifecycle nodes=" + ",".join(inactive))
        unanswered = self._lifecycle_unanswered()
        if unanswered:
            probe.append("unreachable lifecycle services=" + ",".join(unanswered))
        return real, probe

    def _tick(self):
        now = time.monotonic()
        node_names = {name for name, _namespace in self.get_node_names_and_namespaces()}
        slam_running = (
            "slam_toolbox" in node_names or "async_slam_toolbox_node" in node_names
        )
        # Keep probing even while FAILED: an operator re-arm should land on a
        # fresh picture, not on stale state from the moment we latched.
        self._request_lifecycle_states()
        publishers = self.get_publishers_info_by_topic("/map")
        map_odom_live = (
            self.map_odom_last_seen is not None
            and now - self.map_odom_last_seen <= 2.0
        )
        try:
            transform_ready = self.tf_buffer.can_transform(
                "map", "base_link", Time(), timeout=Duration(seconds=0.05)
            )
        except Exception:
            transform_ready = False
        real_missing, probe_missing = self._missing_conditions(
            publishers, map_odom_live, transform_ready
        )
        if slam_running:
            real_missing.insert(0, "slam_toolbox holds a second map->odom authority")

        if self.failed:
            self._failed_tick(now, real_missing, probe_missing)
            return

        if slam_running:
            # A second map->odom authority really is running. Real hazard: stop.
            self._fail("slam_toolbox must be stopped by its session owner", estop=True)
            return

        conditions = (
            len(publishers) == 1
            and publishers[0].node_name.lstrip("/") == "map_server",
            map_odom_live,
            self.pose_valid,
            transform_ready,
            self._lifecycle_all_ready(),
            # [2026-08-08] 충돌 감시가 눈을 뜨고 있어야 READY 다.
            self._safety_scan_live(),
        )
        if not self.pose_valid:
            self._seed_initial_pose(now)

        if all(conditions):
            self.lost_since = None
            self.degraded_since = None
            self.rearm_verify = False
            if self.ready_since is None:
                self.ready_since = now
            if not self.ready and now - self.ready_since >= self.settle:
                self.ready = True
                self._persist("READY", "")
                self.get_logger().info(
                    f"scouting ready for {self.map_file}; reapply patrol route"
                )
            if self.ready and now - self.last_heartbeat >= 1.0:
                self.last_heartbeat = now
                self._persist("READY", "")
            return

        was_ready = self.ready
        self.ready_since = None
        if self.rearm_verify and real_missing:
            # A re-arm asks for a fresh judgement, not for the benefit of the
            # doubt. Something real is still broken, so fail again now rather
            # than sitting in WAITING for the full readiness window.
            self._fail(
                "re-arm rejected, conditions are still bad: "
                + "; ".join(real_missing),
                estop=True,
            )
            return
        if not real_missing and probe_missing:
            # Patch C + D: the only thing wrong is that we cannot reach the
            # lifecycle services -- the 2026-08-07 CPU-saturation case. Never
            # e-stop, never latch, retry forever. Before the first READY we
            # cannot claim readiness; after it, degraded_keeps_ready decides
            # whether an in-flight patrol keeps running.
            keep_ready = was_ready and self.degraded_keeps_ready
            if (
                was_ready
                and self.probe_degraded_max > 0.0
                and self.degraded_since is not None
                and now - self.degraded_since >= self.probe_degraded_max
            ):
                # Blind for probe_degraded_max_sec (default 60s) while driving.
                # Set that parameter to 0.0 to disable this escalation.
                self._fail(
                    "scouting lifecycle probes unanswered for "
                    f"{self.probe_degraded_max:.0f}s while driving: "
                    + "; ".join(probe_missing),
                    estop=True,
                )
                return
            self._degrade("; ".join(probe_missing), now, keep_ready)
            return

        if was_ready:
            # Ride out a brief loss instead of e-stopping on it. Keep
            # heartbeating so the bridge's 3 s freshness window does not lapse
            # and cancel an otherwise healthy patrol.
            if self.lost_since is None:
                self.lost_since = now
                self.get_logger().warning(
                    "scouting readiness dipped; holding for "
                    f"{self.loss_grace:.1f}s before e-stopping"
                )
            if now - self.lost_since < self.loss_grace:
                if now - self.last_heartbeat >= 1.0:
                    self.last_heartbeat = now
                    self._persist("READY", "")
                return
            self._fail(
                "scouting authority or localization readiness was lost: "
                + "; ".join(real_missing),
                estop=True,
            )
            return
        if now - self.started >= self.timeout:
            self._fail(
                "scouting readiness timeout: " + "; ".join(real_missing + probe_missing),
                estop=True,
            )


def main(args=None):
    rclpy.init(args=args)
    node = ScoutingGuard()
    try:
        rclpy.spin(node)
    finally:
        if not node.failed:
            node.ready = False
            node._persist("STOPPED", "scouting runtime stopped")
        node.destroy_node()
        if rclpy.ok():
            rclpy.try_shutdown()
    raise SystemExit(1 if node.failed else 0)


if __name__ == "__main__":
    main()
