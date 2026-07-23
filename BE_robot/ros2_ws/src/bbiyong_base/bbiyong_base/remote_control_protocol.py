"""Pure parsing and safety policy for remote-control WSS messages."""

from dataclasses import dataclass
import json
from math import isfinite


@dataclass(frozen=True)
class RemoteActions:
    linear: float | None = None
    angular: float | None = None
    mode: str | None = None
    estop: bool | None = None


def failsafe_actions() -> RemoteActions:
    """The only action used after transport loss, parse failures, or shutdown."""
    return RemoteActions(linear=0.0, angular=0.0, mode="disabled", estop=True)


def _finite_number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a number")
    converted = float(value)
    if not isfinite(converted):
        raise ValueError(f"{field} must be finite")
    return converted


def parse_remote_command(payload: str, max_linear: float, max_angular: float) -> RemoteActions:
    """Parse one complete WSS text message without ever releasing emergency stop."""
    if max_linear <= 0.0 or max_angular <= 0.0:
        raise ValueError("remote command limits must be positive")
    try:
        message = json.loads(payload)
    except json.JSONDecodeError as error:
        raise ValueError("message must be valid JSON") from error
    if not isinstance(message, dict):
        raise ValueError("message must be a JSON object")
    command = message.get("command")
    if not isinstance(command, str):
        raise ValueError("command must be a string")
    command = command.upper()

    if command == "DRIVE":
        linear = _finite_number(message.get("linear"), "linear")
        angular = _finite_number(message.get("angular"), "angular")
        return RemoteActions(
            linear=max(-max_linear, min(max_linear, linear)),
            angular=max(-max_angular, min(max_angular, angular)),
        )
    if command == "SET_MODE":
        mode = message.get("mode")
        if not isinstance(mode, str):
            raise ValueError("mode must be a string")
        normalized = {"manual": "manual", "autonomy": "autonomy", "disabled": "disabled"}.get(
            mode.strip().lower()
        )
        if normalized is None:
            raise ValueError("mode must be disabled, manual, or autonomy")
        return RemoteActions(mode=normalized)
    if command == "ESTOP":
        if message.get("active", True) is not True:
            raise ValueError("remote ESTOP may only be activated")
        return RemoteActions(estop=True)
    raise ValueError(f"unsupported command: {command}")
