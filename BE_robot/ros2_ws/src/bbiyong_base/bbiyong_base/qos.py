"""Shared QoS profiles for control-authority topics.

(S15P11E101-801) control_state_bridge.py latches /bbiyong/control_mode and
/bbiyong/estop with TRANSIENT_LOCAL durability so a late-joining subscriber
gets the current arm/estop state immediately instead of waiting on DDS
discovery or the next publish tick — which was observed on real hardware to
take several seconds to tens of seconds. A subscriber built with a bare
integer depth (e.g. `create_subscription(..., 10)`) defaults to VOLATILE and
silently misses that latched value. Every publisher/subscriber that touches
control_mode or estop must use CONTROL_STATE_QOS instead of redefining its own
QoSProfile.
"""

from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy

CONTROL_STATE_QOS = QoSProfile(
    depth=1,
    durability=DurabilityPolicy.TRANSIENT_LOCAL,
    reliability=ReliabilityPolicy.RELIABLE,
)
