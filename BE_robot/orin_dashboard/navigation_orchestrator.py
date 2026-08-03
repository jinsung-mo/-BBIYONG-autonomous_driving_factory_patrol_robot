#!/usr/bin/env python3
"""Feature-gated navigation/control orchestration for the cloud transport."""

from __future__ import annotations

import asyncio
from enum import Enum
import json
import math
import os
from pathlib import Path
import shlex
import time


class NavigationState(str, Enum):
    DISABLED = "DISABLED"
    MANUAL = "MANUAL"
    AUTONOMY_IDLE = "AUTONOMY_IDLE"
    PATROLLING = "PATROLLING"
    NAVIGATING = "NAVIGATING"
    ESTOPPED = "ESTOPPED"
    FAILED = "FAILED"


ACTIVE_NAVIGATION = {NavigationState.PATROLLING, NavigationState.NAVIGATING}
MAX_WAYPOINTS = 500


def atomic_write_json(path, payload):
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    os.replace(temporary, target)


def _finite_number(value, field):
    if isinstance(value, bool):
        raise ValueError(f"{field} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be a finite number") from exc
    if not math.isfinite(number):
        raise ValueError(f"{field} must be a finite number")
    return number


def validate_route(waypoints):
    if not isinstance(waypoints, list):
        raise ValueError("waypoints must be a list")
    if not waypoints:
        raise ValueError("waypoints must not be empty")
    if len(waypoints) > MAX_WAYPOINTS:
        raise ValueError(f"waypoints exceeds maximum of {MAX_WAYPOINTS}")

    result = []
    sequences = set()
    for index, raw in enumerate(waypoints):
        if not isinstance(raw, dict):
            raise ValueError(f"waypoints[{index}] must be an object")
        sequence_value = raw.get("seq", index)
        if isinstance(sequence_value, bool):
            raise ValueError(f"waypoints[{index}].seq must be an integer")
        try:
            sequence = int(sequence_value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"waypoints[{index}].seq must be an integer") from exc
        if sequence < 0 or sequence in sequences:
            raise ValueError("waypoint seq values must be unique non-negative integers")
        sequences.add(sequence)
        name = str(raw.get("name") or "")[:120]
        result.append({
            "seq": sequence,
            "x": _finite_number(raw.get("x"), f"waypoints[{index}].x"),
            "y": _finite_number(raw.get("y"), f"waypoints[{index}].y"),
            "yaw": _finite_number(
                0.0 if raw.get("yaw") is None else raw.get("yaw"),
                f"waypoints[{index}].yaw",
            ),
            "name": name,
        })
    return sorted(result, key=lambda item: item["seq"])


class NavigationOrchestrator:
    """Serialize backend navigation commands without importing ROS into the bridge."""

    def __init__(
        self,
        robot_id,
        route_file,
        state_file,
        control_file,
        patrol_command=None,
        navigate_command=None,
        process_stop_timeout=3.0,
    ):
        self.robot_id = robot_id
        self.route_file = Path(route_file).expanduser()
        self.state_file = Path(state_file).expanduser()
        self.control_file = Path(control_file).expanduser()
        self.patrol_command = patrol_command
        self.navigate_command = navigate_command
        self.process_stop_timeout = float(process_stop_timeout)
        self.state = NavigationState.DISABLED
        self.error = None
        self.route = self._load_route()
        self._process = None
        self._monitor_task = None
        self._generation = 0
        self._request_generation = 0
        self._control_sequence = self._load_control_sequence()
        self._lock = asyncio.Lock()
        # Reconnect or process restart must never resume motion.
        self._write_control("disabled", True)
        self._persist()

    @property
    def telemetry_status(self):
        if self.state == NavigationState.PATROLLING:
            return "AUTO_PATROL"
        if self.state == NavigationState.MANUAL:
            return "MANUAL_CONTROL"
        return None

    @property
    def active(self):
        return self.state in ACTIVE_NAVIGATION

    @property
    def estop_engaged(self):
        try:
            payload = json.loads(self.control_file.read_text(encoding="utf-8"))
            return bool(payload.get("estop", True))
        except (OSError, ValueError, TypeError):
            return True

    def _load_route(self):
        try:
            payload = json.loads(self.route_file.read_text(encoding="utf-8"))
            if payload.get("robotId") != self.robot_id:
                return []
            return validate_route(payload.get("waypoints"))
        except (OSError, ValueError, TypeError):
            return []

    def _load_control_sequence(self):
        try:
            payload = json.loads(self.control_file.read_text(encoding="utf-8"))
            return max(0, int(payload.get("seq", 0)))
        except (OSError, ValueError, TypeError):
            return 0

    def _persist(self):
        atomic_write_json(self.state_file, {
            "schemaVersion": 1,
            "robotId": self.robot_id,
            "state": self.state.value,
            "error": self.error,
            "routeCount": len(self.route),
            "updatedAt": time.time(),
        })

    def _transition(self, state, error=None):
        old = self.state
        self.state = state
        self.error = error
        self._persist()
        print(
            f"[navigation] state {old.value} -> {state.value}"
            + (f" error={error}" if error else ""),
            flush=True,
        )

    def _write_control(self, mode, estop):
        self._control_sequence += 1
        atomic_write_json(self.control_file, {
            "schemaVersion": 1,
            "seq": self._control_sequence,
            "mode": mode,
            "estop": bool(estop),
            "updatedAt": time.time(),
        })

    def _save_route(self, route):
        atomic_write_json(self.route_file, {
            "schemaVersion": 1,
            "robotId": self.robot_id,
            "updatedAt": time.time(),
            "waypoints": route,
        })
        self.route = route
        self._persist()

    async def handle_command(self, command):
        kind = str(command.get("command") or "").upper()
        if kind == "SET_PATROL_ROUTE":
            return await self.set_route(command.get("waypoints"))
        if kind == "SET_MODE":
            return await self.set_mode(command.get("mode"))
        if kind == "NAVIGATE":
            return await self.navigate(
                command.get("x"), command.get("y"), command.get("yaw")
            )
        if kind == "ESTOP":
            return await self.emergency_stop()
        return False, f"unsupported navigation command {kind}"

    async def set_route(self, waypoints):
        try:
            route = validate_route(waypoints)
        except ValueError as exc:
            return False, str(exc)
        self._request_generation += 1
        request_generation = self._request_generation
        async with self._lock:
            if request_generation != self._request_generation:
                return False, "route update was superseded"
            self._save_route(route)
            if self.state == NavigationState.PATROLLING:
                return True, (
                    f"stored patrol route with {len(route)} waypoints; "
                    "active patrol is unchanged"
                )
            return True, f"stored patrol route with {len(route)} waypoints"

    async def set_mode(self, mode):
        requested = str(mode or "").strip().lower()
        if requested not in {"autonomy", "manual", "disabled"}:
            return False, f"unsupported mode {mode!r}"
        self._request_generation += 1
        request_generation = self._request_generation
        async with self._lock:
            if request_generation != self._request_generation:
                return False, "mode change was superseded"
            if requested == "manual":
                self._write_control("disabled", False)
                await self._terminate_locked()
                self._write_control("manual", False)
                self._transition(NavigationState.MANUAL)
                return True, "manual control enabled"
            if requested == "disabled":
                self._write_control("disabled", False)
                await self._terminate_locked()
                self._transition(NavigationState.DISABLED)
                return True, "navigation disabled"
            return await self._start_patrol_locked(request_generation)

    async def _start_patrol_locked(self, request_generation=None):
        if not self.route:
            return False, "no patrol route is configured"
        if not self.patrol_command:
            return False, "patrol command is not configured"
        self._write_control("disabled", False)
        await self._terminate_locked()
        try:
            await self._start_process_locked(
                self.patrol_command,
                {"route_file": str(self.route_file)},
                NavigationState.PATROLLING,
            )
        except Exception as exc:
            self._write_control("disabled", True)
            self._transition(NavigationState.FAILED, f"patrol launch failed: {exc}")
            return False, self.error
        if (
            request_generation is not None
            and request_generation != self._request_generation
        ):
            await self._terminate_locked()
            return False, "patrol start was superseded"
        self._write_control("autonomy", False)
        return True, "patrol started"

    async def navigate(self, x, y, yaw=None):
        try:
            values = {
                "x": _finite_number(x, "x"),
                "y": _finite_number(y, "y"),
                "yaw": _finite_number(0.0 if yaw is None else yaw, "yaw"),
            }
        except ValueError as exc:
            return False, str(exc)
        self._request_generation += 1
        request_generation = self._request_generation
        async with self._lock:
            if request_generation != self._request_generation:
                return False, "navigation goal was superseded"
            if not self.navigate_command:
                return False, "navigate command is not configured"
            self._write_control("disabled", False)
            await self._terminate_locked()
            try:
                await self._start_process_locked(
                    self.navigate_command, values, NavigationState.NAVIGATING
                )
            except Exception as exc:
                self._write_control("disabled", True)
                self._transition(
                    NavigationState.FAILED, f"navigation launch failed: {exc}"
                )
                return False, self.error
            if request_generation != self._request_generation:
                await self._terminate_locked()
                return False, "navigation goal was superseded"
            self._write_control("autonomy", False)
            return True, "navigation goal started"

    async def emergency_stop(self):
        # File update is synchronous and precedes potentially slower cancellation.
        request_generation = self.request_emergency_stop()
        async with self._lock:
            if request_generation != self._request_generation:
                return False, "emergency stop was superseded by a newer command"
            await self._terminate_locked()
        return True, "emergency stop engaged"

    def request_emergency_stop(self, reason=None):
        """Latch stop synchronously; safe for mapping lifecycle callbacks."""
        self._request_generation += 1
        request_generation = self._request_generation
        self._write_control("disabled", True)
        self._transition(NavigationState.ESTOPPED, reason)
        return request_generation

    def enable_mapping_autonomy(self):
        self._request_generation += 1
        self._write_control("autonomy", False)
        self._transition(NavigationState.AUTONOMY_IDLE)

    async def prepare_for_mapping(self):
        self._request_generation += 1
        request_generation = self._request_generation
        self._write_control("disabled", True)
        async with self._lock:
            if request_generation != self._request_generation:
                return False, "mapping transition was superseded"
            await self._terminate_locked()
            self._transition(NavigationState.DISABLED)
        return True, "navigation stopped for mapping"

    async def _start_process_locked(self, template, values, target_state):
        arguments = [part.format(**values) for part in shlex.split(template)]
        process = await asyncio.create_subprocess_exec(*arguments)
        self._generation += 1
        generation = self._generation
        self._process = process
        self._transition(target_state)
        self._monitor_task = asyncio.create_task(
            self._monitor(process, generation, target_state)
        )

    async def _monitor(self, process, generation, target_state):
        return_code = await process.wait()
        async with self._lock:
            if generation != self._generation or process is not self._process:
                return
            self._process = None
            if return_code == 0:
                self._write_control("disabled", False)
                self._transition(NavigationState.AUTONOMY_IDLE)
            else:
                self._write_control("disabled", True)
                self._transition(
                    NavigationState.FAILED,
                    f"{target_state.value.lower()} process exited {return_code}",
                )

    async def _terminate_locked(self):
        process = self._process
        if process is None or process.returncode is not None:
            self._process = None
            return
        self._generation += 1
        self._process = None
        process.terminate()
        try:
            await asyncio.wait_for(
                process.wait(), timeout=self.process_stop_timeout
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
