"""ROS-independent frontier detection and scoring utilities."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from math import ceil, cos, hypot, sin
from typing import Iterable, Sequence


Cell = tuple[int, int]
Point = tuple[float, float]


@dataclass(frozen=True)
class GridSpec:
    """Geometry and occupancy values of a two-dimensional occupancy grid."""

    width: int
    height: int
    resolution: float
    origin_x: float
    origin_y: float
    origin_yaw: float
    data: Sequence[int]

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("grid width and height must be positive")
        if self.resolution <= 0.0:
            raise ValueError("grid resolution must be positive")
        if len(self.data) != self.width * self.height:
            raise ValueError("grid data size does not match width * height")

    def contains(self, cell: Cell) -> bool:
        x, y = cell
        return 0 <= x < self.width and 0 <= y < self.height

    def value(self, cell: Cell) -> int:
        x, y = cell
        return int(self.data[y * self.width + x])

    def cell_to_world(self, cell: Cell) -> Point:
        """Return the world coordinate at the center of a grid cell."""
        local_x = (cell[0] + 0.5) * self.resolution
        local_y = (cell[1] + 0.5) * self.resolution
        yaw_cos = cos(self.origin_yaw)
        yaw_sin = sin(self.origin_yaw)
        return (
            self.origin_x + yaw_cos * local_x - yaw_sin * local_y,
            self.origin_y + yaw_sin * local_x + yaw_cos * local_y,
        )

    def world_to_cell(self, point: Point) -> Cell | None:
        """Convert a world coordinate to a grid cell, including origin rotation."""
        delta_x = point[0] - self.origin_x
        delta_y = point[1] - self.origin_y
        yaw_cos = cos(self.origin_yaw)
        yaw_sin = sin(self.origin_yaw)
        local_x = yaw_cos * delta_x + yaw_sin * delta_y
        local_y = -yaw_sin * delta_x + yaw_cos * delta_y
        cell = (int(local_x // self.resolution), int(local_y // self.resolution))
        return cell if self.contains(cell) else None


@dataclass(frozen=True)
class FrontierCluster:
    """Connected frontier cells and the selected reachable goal cell."""

    cells: tuple[Cell, ...]
    goal_cell: Cell

    @property
    def size(self) -> int:
        return len(self.cells)


def _neighbors4(cell: Cell) -> Iterable[Cell]:
    x, y = cell
    yield x - 1, y
    yield x + 1, y
    yield x, y - 1
    yield x, y + 1


def _neighbors8(cell: Cell) -> Iterable[Cell]:
    x, y = cell
    for offset_y in (-1, 0, 1):
        for offset_x in (-1, 0, 1):
            if offset_x or offset_y:
                yield x + offset_x, y + offset_y


def reachable_free_cells(
    grid: GridSpec,
    start: Cell,
    free_threshold: int = 20,
) -> set[Cell]:
    """Flood-fill free cells connected to ``start``.

    If the robot cell is unknown or occupied, the nearest free cell in a small
    neighborhood is used. This tolerates a map update briefly lagging the TF.
    """
    if not grid.contains(start):
        return set()

    def is_free(cell: Cell) -> bool:
        value = grid.value(cell)
        return 0 <= value <= free_threshold

    seed = start if is_free(start) else None
    if seed is None:
        candidates: list[tuple[int, Cell]] = []
        for y in range(max(0, start[1] - 2), min(grid.height, start[1] + 3)):
            for x in range(max(0, start[0] - 2), min(grid.width, start[0] + 3)):
                cell = (x, y)
                if is_free(cell):
                    candidates.append((abs(x - start[0]) + abs(y - start[1]), cell))
        if not candidates:
            return set()
        seed = min(candidates, key=lambda item: item[0])[1]

    visited = {seed}
    queue: deque[Cell] = deque([seed])
    while queue:
        current = queue.popleft()
        for neighbor in _neighbors4(current):
            if (
                neighbor not in visited
                and grid.contains(neighbor)
                and is_free(neighbor)
            ):
                visited.add(neighbor)
                queue.append(neighbor)
    return visited


def detect_frontier_clusters(
    grid: GridSpec,
    robot_cell: Cell,
    free_threshold: int = 20,
    min_cluster_size: int = 5,
    occupied_threshold: int = 65,
    min_obstacle_clearance_m: float = 0.0,
) -> list[FrontierCluster]:
    """Find connected reachable free cells adjacent to unknown space."""
    reachable = reachable_free_cells(grid, robot_cell, free_threshold)
    clearance_cells = max(0, ceil(min_obstacle_clearance_m / grid.resolution))

    def has_clearance(cell: Cell) -> bool:
        if clearance_cells == 0:
            return True
        for y in range(cell[1] - clearance_cells, cell[1] + clearance_cells + 1):
            for x in range(cell[0] - clearance_cells, cell[0] + clearance_cells + 1):
                neighbor = (x, y)
                if grid.contains(neighbor) and grid.value(neighbor) >= occupied_threshold:
                    return False
        return True

    frontier_cells = {
        cell
        for cell in reachable
        if has_clearance(cell)
        if any(
            grid.contains(neighbor) and grid.value(neighbor) < 0
            for neighbor in _neighbors4(cell)
        )
    }

    clusters: list[FrontierCluster] = []
    remaining = set(frontier_cells)
    while remaining:
        seed = remaining.pop()
        cluster = {seed}
        queue: deque[Cell] = deque([seed])
        while queue:
            current = queue.popleft()
            for neighbor in _neighbors8(current):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    cluster.add(neighbor)
                    queue.append(neighbor)

        if len(cluster) < min_cluster_size:
            continue

        center_x = sum(cell[0] for cell in cluster) / len(cluster)
        center_y = sum(cell[1] for cell in cluster) / len(cluster)
        goal_cell = min(
            cluster,
            key=lambda cell: (cell[0] - center_x) ** 2 + (cell[1] - center_y) ** 2,
        )
        clusters.append(FrontierCluster(tuple(sorted(cluster)), goal_cell))
    return clusters


def frontier_score(
    grid: GridSpec,
    cluster: FrontierCluster,
    robot_position: Point,
    information_gain_weight: float,
    distance_weight: float,
) -> float:
    """Favor long frontiers while penalizing travel distance."""
    goal = grid.cell_to_world(cluster.goal_cell)
    frontier_length = cluster.size * grid.resolution
    distance = hypot(goal[0] - robot_position[0], goal[1] - robot_position[1])
    return information_gain_weight * frontier_length - distance_weight * distance


def select_frontier(
    grid: GridSpec,
    clusters: Sequence[FrontierCluster],
    robot_position: Point,
    blacklist: Sequence[Point] = (),
    blacklist_radius: float = 0.5,
    min_frontier_distance: float = 0.4,
    information_gain_weight: float = 1.0,
    distance_weight: float = 1.0,
) -> FrontierCluster | None:
    """Return the highest-scoring frontier outside exclusion radii."""
    candidates: list[tuple[float, FrontierCluster]] = []
    for cluster in clusters:
        goal = grid.cell_to_world(cluster.goal_cell)
        if (
            hypot(goal[0] - robot_position[0], goal[1] - robot_position[1])
            < min_frontier_distance
        ):
            continue
        if any(
            hypot(goal[0] - point[0], goal[1] - point[1]) <= blacklist_radius
            for point in blacklist
        ):
            continue
        candidates.append(
            (
                frontier_score(
                    grid,
                    cluster,
                    robot_position,
                    information_gain_weight,
                    distance_weight,
                ),
                cluster,
            )
        )
    return max(candidates, key=lambda item: item[0])[1] if candidates else None
