"""ROS-independent frontier detection and scoring utilities."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from math import atan2, ceil, cos, hypot, pi, sin
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
    unknown_normal: Point = (0.0, 0.0)
    obstacle_clearance_m: float = 0.0
    is_exterior: bool = False
    wall_distance_m: float = float("inf")
    wall_length_m: float = 0.0
    wall_point: Point | None = None
    wall_tangent: float | None = None

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
    goal_standoff_m: float = 0.0,
    openness_radius_m: float = 1.0,
    require_known_goal_clearance: bool = True,
    wall_search_radius_m: float = 1.2,
) -> list[FrontierCluster]:
    """Find frontiers and put each goal safely back inside known free space."""
    reachable = reachable_free_cells(grid, robot_cell, free_threshold)
    clearance_cells = max(0, ceil(min_obstacle_clearance_m / grid.resolution))
    standoff_cells = max(0.0, goal_standoff_m / grid.resolution)
    openness_cells = max(1, ceil(openness_radius_m / grid.resolution))
    wall_search_cells = max(1, ceil(wall_search_radius_m / grid.resolution))

    def make_integral(predicate) -> list[int]:
        """Build a summed-area table for constant-time rectangular queries."""
        stride = grid.width + 1
        integral = [0] * (stride * (grid.height + 1))
        for y in range(grid.height):
            row_sum = 0
            source_offset = y * grid.width
            target_offset = (y + 1) * stride
            previous_offset = y * stride
            for x in range(grid.width):
                row_sum += int(predicate((x, y), grid.data[source_offset + x]))
                integral[target_offset + x + 1] = (
                    integral[previous_offset + x + 1] + row_sum
                )
        return integral

    def rectangle_sum(
        integral: Sequence[int],
        min_x: int,
        min_y: int,
        max_x: int,
        max_y: int,
    ) -> int:
        """Return the inclusive rectangle sum, clipped to the map."""
        min_x = max(0, min_x)
        min_y = max(0, min_y)
        max_x = min(grid.width - 1, max_x)
        max_y = min(grid.height - 1, max_y)
        if min_x > max_x or min_y > max_y:
            return 0
        stride = grid.width + 1
        left = min_x
        right = max_x + 1
        top = min_y
        bottom = max_y + 1
        return (
            integral[bottom * stride + right]
            - integral[top * stride + right]
            - integral[bottom * stride + left]
            + integral[top * stride + left]
        )

    occupied_integral = make_integral(
        lambda _cell, value: value >= occupied_threshold
    )
    invalid_free_integral = make_integral(
        lambda cell, value: cell not in reachable or not (0 <= value <= free_threshold)
    )

    # Label connected occupied components once. Long connected components are
    # treated as structural wall candidates; small islands remain ordinary
    # obstacles and cannot attract perimeter mode.
    occupied_cells = {
        (x, y)
        for y in range(grid.height)
        for x in range(grid.width)
        if grid.value((x, y)) >= occupied_threshold
    }
    occupied_component: dict[Cell, int] = {}
    components: list[tuple[Cell, ...]] = []
    remaining_occupied = set(occupied_cells)
    while remaining_occupied:
        seed = remaining_occupied.pop()
        component = {seed}
        component_queue: deque[Cell] = deque([seed])
        while component_queue:
            current = component_queue.popleft()
            for neighbor in _neighbors8(current):
                if neighbor in remaining_occupied:
                    remaining_occupied.remove(neighbor)
                    component.add(neighbor)
                    component_queue.append(neighbor)
        component_id = len(components)
        ordered = tuple(sorted(component))
        components.append(ordered)
        for cell in ordered:
            occupied_component[cell] = component_id

    def has_clearance(cell: Cell) -> bool:
        if clearance_cells == 0:
            return True
        return rectangle_sum(
            occupied_integral,
            cell[0] - clearance_cells,
            cell[1] - clearance_cells,
            cell[0] + clearance_cells,
            cell[1] + clearance_cells,
        ) == 0

    def has_known_free_clearance(cell: Cell) -> bool:
        """Require the complete robot-clearance box to be known free space."""
        min_x = cell[0] - clearance_cells
        min_y = cell[1] - clearance_cells
        max_x = cell[0] + clearance_cells
        max_y = cell[1] + clearance_cells
        if min_x < 0 or min_y < 0 or max_x >= grid.width or max_y >= grid.height:
            return False
        return rectangle_sum(
            invalid_free_integral,
            min_x,
            min_y,
            max_x,
            max_y,
        ) == 0

    def obstacle_clearance(cell: Cell) -> float:
        """Measure local openness, capped so distant walls do not dominate."""
        nearest_cells = float(openness_cells)
        for y in range(
            max(0, cell[1] - openness_cells),
            min(grid.height, cell[1] + openness_cells + 1),
        ):
            for x in range(
                max(0, cell[0] - openness_cells),
                min(grid.width, cell[0] + openness_cells + 1),
            ):
                if grid.value((x, y)) >= occupied_threshold:
                    nearest_cells = min(
                        nearest_cells,
                        hypot(x - cell[0], y - cell[1]),
                    )
        return nearest_cells * grid.resolution

    def wall_context(
        cell: Cell,
    ) -> tuple[float, float, Point | None, float | None]:
        """Return distance, component length, nearest point, and local tangent."""
        nearby = [
            occupied
            for y in range(
                max(0, cell[1] - wall_search_cells),
                min(grid.height, cell[1] + wall_search_cells + 1),
            )
            for x in range(
                max(0, cell[0] - wall_search_cells),
                min(grid.width, cell[0] + wall_search_cells + 1),
            )
            if (occupied := (x, y)) in occupied_cells
            and hypot(x - cell[0], y - cell[1]) <= wall_search_cells
        ]
        if not nearby:
            return float("inf"), 0.0, None, None

        nearest = min(
            nearby,
            key=lambda occupied: hypot(
                occupied[0] - cell[0],
                occupied[1] - cell[1],
            ),
        )
        component = components[occupied_component[nearest]]
        min_x = min(point[0] for point in component)
        max_x = max(point[0] for point in component)
        min_y = min(point[1] for point in component)
        max_y = max(point[1] for point in component)
        component_length = hypot(max_x - min_x, max_y - min_y) * grid.resolution

        local_component = [
            point
            for point in nearby
            if occupied_component[point] == occupied_component[nearest]
        ]
        tangent = None
        if len(local_component) >= 2:
            mean_x = sum(point[0] for point in local_component) / len(local_component)
            mean_y = sum(point[1] for point in local_component) / len(local_component)
            covariance_xx = sum(
                (point[0] - mean_x) ** 2 for point in local_component
            )
            covariance_yy = sum(
                (point[1] - mean_y) ** 2 for point in local_component
            )
            covariance_xy = sum(
                (point[0] - mean_x) * (point[1] - mean_y)
                for point in local_component
            )
            tangent = grid.origin_yaw + 0.5 * atan2(
                2.0 * covariance_xy,
                covariance_xx - covariance_yy,
            )
        return (
            hypot(nearest[0] - cell[0], nearest[1] - cell[1])
            * grid.resolution,
            component_length,
            grid.cell_to_world(nearest),
            tangent,
        )

    frontier_cells = {
        cell
        for cell in reachable
        if has_clearance(cell)
        if any(
            grid.contains(neighbor) and grid.value(neighbor) < 0
            for neighbor in _neighbors4(cell)
        )
    }

    # Split the large, still-unexplored region around the mapped area from
    # small unknown holes enclosed by known cells.  Exploring the exterior
    # first produces a coherent perimeter sweep; enclosed holes are retained
    # for a cleanup pass once no exterior frontier remains.
    exterior_unknown: set[Cell] = set()
    unknown_queue: deque[Cell] = deque()
    for x in range(grid.width):
        for cell in ((x, 0), (x, grid.height - 1)):
            if grid.value(cell) < 0 and cell not in exterior_unknown:
                exterior_unknown.add(cell)
                unknown_queue.append(cell)
    for y in range(grid.height):
        for cell in ((0, y), (grid.width - 1, y)):
            if grid.value(cell) < 0 and cell not in exterior_unknown:
                exterior_unknown.add(cell)
                unknown_queue.append(cell)
    while unknown_queue:
        current = unknown_queue.popleft()
        for neighbor in _neighbors4(current):
            if (
                neighbor not in exterior_unknown
                and grid.contains(neighbor)
                and grid.value(neighbor) < 0
            ):
                exterior_unknown.add(neighbor)
                unknown_queue.append(neighbor)

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
        unknown_neighbors = {
            neighbor
            for cell in cluster
            for neighbor in _neighbors4(cell)
            if grid.contains(neighbor) and grid.value(neighbor) < 0
        }
        if not unknown_neighbors:
            continue
        unknown_x = sum(cell[0] for cell in unknown_neighbors) / len(unknown_neighbors)
        unknown_y = sum(cell[1] for cell in unknown_neighbors) / len(unknown_neighbors)
        normal_x = unknown_x - center_x
        normal_y = unknown_y - center_y
        normal_length = hypot(normal_x, normal_y)
        if normal_length <= 1e-9:
            # A closed frontier around an unknown island (or a nearly complete
            # outer ring) has opposing normals that cancel at its centroid.
            # Keep it usable by approaching the closest local edge instead.
            local_edges: list[tuple[float, Cell, Point]] = []
            for cell in cluster:
                local_unknown = [
                    neighbor
                    for neighbor in _neighbors4(cell)
                    if grid.contains(neighbor) and grid.value(neighbor) < 0
                ]
                if not local_unknown:
                    continue
                local_x = (
                    sum(neighbor[0] for neighbor in local_unknown)
                    / len(local_unknown)
                    - cell[0]
                )
                local_y = (
                    sum(neighbor[1] for neighbor in local_unknown)
                    / len(local_unknown)
                    - cell[1]
                )
                if hypot(local_x, local_y) > 1e-9:
                    local_edges.append(
                        (
                            hypot(
                                cell[0] - robot_cell[0],
                                cell[1] - robot_cell[1],
                            ),
                            cell,
                            (local_x, local_y),
                        )
                    )
            if not local_edges:
                continue
            _, edge_cell, local_normal = min(local_edges, key=lambda item: item[0])
            center_x = float(edge_cell[0])
            center_y = float(edge_cell[1])
            normal_x, normal_y = local_normal
            normal_length = hypot(normal_x, normal_y)
        normal = (normal_x / normal_length, normal_y / normal_length)

        # A frontier cell touches unknown space.  It is a useful observation
        # boundary but a poor navigation goal because the robot footprint or
        # Nav2 inflation may overlap the unknown region.  Move the goal in the
        # opposite direction, back into mapped free space.
        target_x = center_x - normal[0] * standoff_cells
        target_y = center_y - normal[1] * standoff_cells
        maximum_goal_offset = standoff_cells + clearance_cells + 2.0
        search_radius = ceil(maximum_goal_offset)
        safe_candidates = [
            cell
            for y in range(
                max(0, int(target_y) - search_radius),
                min(grid.height, int(target_y) + search_radius + 1),
            )
            for x in range(
                max(0, int(target_x) - search_radius),
                min(grid.width, int(target_x) + search_radius + 1),
            )
            if (cell := (x, y)) in reachable
            and (
                has_known_free_clearance(cell)
                if require_known_goal_clearance
                else has_clearance(cell)
            )
        ]
        if not safe_candidates:
            continue
        goal_cell = min(
            safe_candidates,
            key=lambda cell: (
                (cell[0] - target_x) ** 2 + (cell[1] - target_y) ** 2,
                (cell[0] - robot_cell[0]) ** 2 + (cell[1] - robot_cell[1]) ** 2,
            ),
        )
        if (
            hypot(goal_cell[0] - target_x, goal_cell[1] - target_y)
            > maximum_goal_offset
        ):
            continue
        wall_distance, wall_length, wall_point, wall_tangent = wall_context(goal_cell)
        clusters.append(
            FrontierCluster(
                tuple(sorted(cluster)),
                goal_cell,
                normal,
                obstacle_clearance(goal_cell),
                any(cell in exterior_unknown for cell in unknown_neighbors),
                wall_distance,
                wall_length,
                wall_point,
                wall_tangent,
            )
        )
    return clusters


def frontier_heading(grid: GridSpec, cluster: FrontierCluster) -> float:
    """Return a map-frame yaw that faces from known space toward unknown space."""
    normal_x, normal_y = cluster.unknown_normal
    return grid.origin_yaw + atan2(normal_y, normal_x)


def normalize_angle(angle: float) -> float:
    return (angle + pi) % (2.0 * pi) - pi


def angle_distance(first: float, second: float) -> float:
    return abs(normalize_angle(first - second))


def perimeter_heading(
    grid: GridSpec,
    cluster: FrontierCluster,
    wall_side: str,
) -> float:
    """Return the contour direction that keeps the measured wall on one side."""
    if cluster.wall_point is None:
        return frontier_heading(grid, cluster)
    goal = grid.cell_to_world(cluster.goal_cell)
    toward_wall = atan2(
        cluster.wall_point[1] - goal[1],
        cluster.wall_point[0] - goal[0],
    )
    if wall_side == "left":
        return normalize_angle(toward_wall - pi / 2.0)
    if wall_side == "right":
        return normalize_angle(toward_wall + pi / 2.0)
    raise ValueError("wall_side must be 'left' or 'right'")


def wall_signature(
    cluster: FrontierCluster,
    quantum_m: float = 0.5,
) -> tuple[int, int] | None:
    """Quantize the nearest structural-wall point for multi-update persistence."""
    if cluster.wall_point is None or quantum_m <= 0.0:
        return None
    return (
        round(cluster.wall_point[0] / quantum_m),
        round(cluster.wall_point[1] / quantum_m),
    )


def loop_is_closed(
    start_position: Point,
    start_heading: float,
    current_position: Point,
    current_heading: float,
    traveled_m: float,
    *,
    minimum_travel_m: float,
    position_tolerance_m: float,
    heading_tolerance_rad: float,
) -> bool:
    return (
        traveled_m >= minimum_travel_m
        and hypot(
            current_position[0] - start_position[0],
            current_position[1] - start_position[1],
        )
        <= position_tolerance_m
        and angle_distance(current_heading, start_heading)
        <= heading_tolerance_rad
    )


def frontier_score(
    grid: GridSpec,
    cluster: FrontierCluster,
    robot_position: Point,
    information_gain_weight: float,
    distance_weight: float,
    open_space_weight: float = 0.0,
    robot_heading: float | None = None,
    heading_change_weight: float = 0.0,
) -> float:
    """Favor broad, open frontiers reachable without a large initial turn."""
    goal = grid.cell_to_world(cluster.goal_cell)
    frontier_length = cluster.size * grid.resolution
    distance = hypot(goal[0] - robot_position[0], goal[1] - robot_position[1])
    heading_change = 0.0
    if robot_heading is not None and distance > 1e-9:
        goal_bearing = atan2(
            goal[1] - robot_position[1],
            goal[0] - robot_position[0],
        )
        heading_change = abs(
            (goal_bearing - robot_heading + pi) % (2.0 * pi) - pi
        )
    return (
        information_gain_weight * frontier_length
        + open_space_weight * cluster.obstacle_clearance_m
        - distance_weight * distance
        - heading_change_weight * heading_change
    )


def select_perimeter_frontier(
    grid: GridSpec,
    clusters: Sequence[FrontierCluster],
    robot_position: Point,
    robot_heading: float,
    *,
    wall_side: str,
    target_wall_distance_m: float,
    wall_distance_tolerance_m: float,
    minimum_structural_wall_length_m: float,
    perimeter_heading_weight: float,
    previous_wall_point: Point | None = None,
    blacklist: Sequence[Point] = (),
    blacklist_radius: float = 0.5,
    min_frontier_distance: float = 0.4,
    require_exterior: bool = True,
) -> FrontierCluster | None:
    """Select a frontier that continues a stable wall contour."""
    candidates: list[tuple[float, float, FrontierCluster]] = []
    tolerance = max(0.05, wall_distance_tolerance_m)
    for cluster in clusters:
        if (
            (require_exterior and not cluster.is_exterior)
            or cluster.wall_point is None
            or cluster.wall_length_m < minimum_structural_wall_length_m
        ):
            continue
        goal = grid.cell_to_world(cluster.goal_cell)
        distance = hypot(
            goal[0] - robot_position[0],
            goal[1] - robot_position[1],
        )
        if distance < min_frontier_distance:
            continue
        if any(
            hypot(goal[0] - point[0], goal[1] - point[1]) <= blacklist_radius
            for point in blacklist
        ):
            continue

        desired_heading = perimeter_heading(grid, cluster, wall_side)
        heading_change = angle_distance(desired_heading, robot_heading)
        wall_error = abs(cluster.wall_distance_m - target_wall_distance_m)
        # A score penalty alone still allows an attractive but physically
        # invalid goal beside a wall. Keep wall-follow goals inside an explicit
        # distance band; Nav2 remains responsible for the final path check.
        if wall_error > tolerance:
            continue
        continuation_gap = (
            hypot(
                cluster.wall_point[0] - previous_wall_point[0],
                cluster.wall_point[1] - previous_wall_point[1],
            )
            if previous_wall_point is not None
            else 0.0
        )
        score = (
            1.5 * cluster.size * grid.resolution
            + 0.5 * cluster.obstacle_clearance_m
            + min(2.0, cluster.wall_length_m) * 0.5
            - 0.4 * distance
            - perimeter_heading_weight * heading_change
            - 2.0 * wall_error / tolerance
            - 1.5 * continuation_gap
        )
        candidates.append((score, continuation_gap, cluster))

    if previous_wall_point is not None:
        nearby = [candidate for candidate in candidates if candidate[1] <= 1.5]
        if nearby:
            candidates = nearby
    return max(candidates, key=lambda item: item[0])[2] if candidates else None


def select_frontier(
    grid: GridSpec,
    clusters: Sequence[FrontierCluster],
    robot_position: Point,
    blacklist: Sequence[Point] = (),
    blacklist_radius: float = 0.5,
    min_frontier_distance: float = 0.4,
    information_gain_weight: float = 1.0,
    distance_weight: float = 1.0,
    open_space_weight: float = 0.0,
    prefer_exterior: bool = True,
    robot_heading: float | None = None,
    heading_change_weight: float = 0.0,
) -> FrontierCluster | None:
    """Return the best eligible frontier, sweeping exterior space first."""
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
                    open_space_weight,
                    robot_heading,
                    heading_change_weight,
                ),
                cluster,
            )
        )
    if prefer_exterior and any(cluster.is_exterior for _, cluster in candidates):
        candidates = [
            candidate for candidate in candidates if candidate[1].is_exterior
        ]
    return max(candidates, key=lambda item: item[0])[1] if candidates else None
