from math import pi
import unittest

from bbiyong_explorer.frontier import (
    FrontierCluster,
    GridSpec,
    detect_frontier_clusters,
    frontier_heading,
    loop_is_closed,
    perimeter_heading,
    reachable_free_cells,
    select_frontier,
    select_perimeter_frontier,
)


def make_grid(rows, resolution=1.0, origin=(0.0, 0.0, 0.0)):
    return GridSpec(
        width=len(rows[0]),
        height=len(rows),
        resolution=resolution,
        origin_x=origin[0],
        origin_y=origin[1],
        origin_yaw=origin[2],
        data=[value for row in rows for value in row],
    )


class FrontierTests(unittest.TestCase):
    def test_grid_size_must_match_metadata(self):
        with self.assertRaises(ValueError):
            GridSpec(2, 2, 1.0, 0.0, 0.0, 0.0, [0, 0])

    def test_cell_world_round_trip_with_rotated_origin(self):
        grid = GridSpec(4, 4, 0.5, 10.0, -2.0, pi / 2.0, [0] * 16)
        world = grid.cell_to_world((1, 2))
        self.assertEqual(grid.world_to_cell(world), (1, 2))

    def test_reachable_free_cells_do_not_cross_obstacles(self):
        grid = make_grid(
            [
                [0, 0, 100, 0, 0],
                [0, 0, 100, 0, 0],
                [0, 0, 100, 0, 0],
            ]
        )
        reachable = reachable_free_cells(grid, (0, 1))
        self.assertIn((1, 1), reachable)
        self.assertNotIn((3, 1), reachable)

    def test_detects_only_reachable_frontier_cluster(self):
        unknown = -1
        grid = make_grid(
            [
                [unknown, unknown, unknown, unknown, unknown, unknown, unknown],
                [unknown, 0, 0, 0, 100, 0, unknown],
                [unknown, 0, 0, 0, 100, 0, unknown],
                [unknown, 0, 0, 0, 100, 0, unknown],
                [unknown, unknown, unknown, unknown, unknown, unknown, unknown],
            ]
        )
        clusters = detect_frontier_clusters(grid, (2, 2), min_cluster_size=3)
        self.assertEqual(len(clusters), 1)
        self.assertTrue(all(cell[0] <= 3 for cell in clusters[0].cells))

    def test_cluster_size_filter_removes_small_noise(self):
        grid = make_grid(
            [
                [100, 100, 100],
                [100, 0, -1],
                [100, 100, 100],
            ]
        )
        self.assertEqual(
            detect_frontier_clusters(grid, (1, 1), min_cluster_size=2), []
        )

    def test_frontier_goal_keeps_obstacle_clearance(self):
        grid = make_grid(
            [
                [-1, -1, -1, -1, -1],
                [0, 0, 0, 0, 0],
                [0, 0, 100, 0, 0],
            ]
        )
        clusters = detect_frontier_clusters(
            grid,
            (0, 1),
            min_cluster_size=1,
            min_obstacle_clearance_m=1.0,
        )
        frontier_cells = {cell for cluster in clusters for cell in cluster.cells}
        self.assertNotIn((2, 1), frontier_cells)

    def test_goal_stands_back_in_known_free_space_and_faces_unknown(self):
        grid = make_grid(
            [
                [100, -1, -1, -1, -1, -1, 100],
                [100, 0, 0, 0, 0, 0, 100],
                [100, 0, 0, 0, 0, 0, 100],
                [100, 0, 0, 0, 0, 0, 100],
                [100, 0, 0, 0, 0, 0, 100],
                [100, 100, 100, 100, 100, 100, 100],
            ]
        )
        clusters = detect_frontier_clusters(
            grid,
            (3, 4),
            min_cluster_size=3,
            min_obstacle_clearance_m=1.0,
            goal_standoff_m=2.0,
        )

        self.assertEqual(len(clusters), 1)
        cluster = clusters[0]
        self.assertEqual(cluster.goal_cell[1], 3)
        self.assertEqual(grid.value(cluster.goal_cell), 0)
        self.assertAlmostEqual(cluster.unknown_normal[0], 0.0)
        self.assertLess(cluster.unknown_normal[1], 0.0)
        self.assertAlmostEqual(frontier_heading(grid, cluster), -pi / 2.0)

    def test_exploration_can_goal_on_narrow_lidar_cleared_ray(self):
        grid = make_grid(
            [
                [-1, -1, -1, -1, -1, -1, -1],
                [-1, -1, -1, -1, -1, -1, -1],
                [0, 0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0, 0],
            ]
        )
        strict = detect_frontier_clusters(
            grid,
            (0, 2),
            min_cluster_size=3,
            min_obstacle_clearance_m=2.0,
            goal_standoff_m=1.0,
        )
        exploration = detect_frontier_clusters(
            grid,
            (0, 2),
            min_cluster_size=3,
            min_obstacle_clearance_m=2.0,
            goal_standoff_m=1.0,
            require_known_goal_clearance=False,
        )

        self.assertEqual(strict, [])
        self.assertGreater(len(exploration), 0)

    def test_frontier_heading_includes_rotated_map_origin(self):
        grid = make_grid([[0]], origin=(0.0, 0.0, pi / 2.0))
        cluster = FrontierCluster(((0, 0),), (0, 0), (1.0, 0.0))
        self.assertAlmostEqual(frontier_heading(grid, cluster), pi / 2.0)

    def test_distinguishes_exterior_frontier_from_enclosed_unknown_hole(self):
        rows = [[-1] * 11]
        rows.extend([[100] + [0] * 9 + [100] for _ in range(9)])
        rows.append([100] * 11)
        rows[5][5] = -1
        grid = make_grid(rows)

        clusters = detect_frontier_clusters(grid, (2, 2), min_cluster_size=1)

        self.assertTrue(any(cluster.is_exterior for cluster in clusters))
        self.assertTrue(any(not cluster.is_exterior for cluster in clusters))

    def test_select_frontier_balances_gain_and_distance(self):
        grid = make_grid([[0] * 12 for _ in range(3)])
        near = FrontierCluster(((2, 1), (2, 2)), (2, 1))
        large_far = FrontierCluster(tuple((x, 1) for x in range(7, 12)), (8, 1))

        selected = select_frontier(
            grid,
            [near, large_far],
            robot_position=(0.5, 1.5),
            information_gain_weight=3.0,
            distance_weight=0.2,
        )
        self.assertEqual(selected, large_far)

    def test_select_frontier_respects_blacklist_and_minimum_distance(self):
        grid = make_grid([[0] * 8 for _ in range(3)])
        too_close = FrontierCluster(((0, 1),), (0, 1))
        blacklisted = FrontierCluster(((3, 1),), (3, 1))
        valid = FrontierCluster(((6, 1),), (6, 1))

        selected = select_frontier(
            grid,
            [too_close, blacklisted, valid],
            robot_position=(0.5, 1.5),
            blacklist=[grid.cell_to_world((3, 1))],
            blacklist_radius=0.5,
            min_frontier_distance=1.0,
        )
        self.assertEqual(selected, valid)

    def test_select_frontier_prefers_open_approach_over_scattered_obstacles(self):
        grid = make_grid([[0] * 10 for _ in range(3)])
        cluttered = FrontierCluster(
            ((4, 1), (4, 2)),
            (4, 1),
            obstacle_clearance_m=0.35,
        )
        open_frontier = FrontierCluster(
            ((5, 1), (5, 2)),
            (5, 1),
            obstacle_clearance_m=1.0,
        )

        selected = select_frontier(
            grid,
            [cluttered, open_frontier],
            robot_position=(0.5, 1.5),
            information_gain_weight=1.0,
            distance_weight=0.1,
            open_space_weight=2.0,
        )

        self.assertEqual(selected, open_frontier)

    def test_select_frontier_sweeps_exterior_before_interior_cleanup(self):
        grid = make_grid([[0] * 12 for _ in range(3)])
        large_near_interior = FrontierCluster(
            tuple((x, 1) for x in range(1, 8)),
            (2, 1),
            is_exterior=False,
        )
        small_far_exterior = FrontierCluster(
            ((9, 1), (10, 1)),
            (9, 1),
            is_exterior=True,
        )

        selected = select_frontier(
            grid,
            [large_near_interior, small_far_exterior],
            robot_position=(0.5, 1.5),
            information_gain_weight=1.0,
            distance_weight=1.0,
        )

        self.assertEqual(selected, small_far_exterior)

    def test_select_frontier_prefers_goal_near_current_heading(self):
        grid = make_grid([[0] * 9 for _ in range(9)])
        ahead = FrontierCluster(((7, 4), (7, 5)), (7, 4))
        behind = FrontierCluster(
            ((1, 4), (1, 5), (1, 6), (1, 7)),
            (1, 4),
        )

        selected = select_frontier(
            grid,
            [ahead, behind],
            robot_position=grid.cell_to_world((4, 4)),
            robot_heading=0.0,
            heading_change_weight=2.0,
            information_gain_weight=1.0,
            distance_weight=0.1,
        )

        self.assertEqual(selected, ahead)

    def test_detected_frontier_records_nearby_structural_wall(self):
        grid = make_grid(
            [
                [-1, -1, -1, -1, -1, -1, -1],
                [0, 0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0, 0],
                [100, 100, 100, 100, 100, 100, 100],
            ],
            resolution=0.25,
        )
        clusters = detect_frontier_clusters(
            grid,
            (3, 2),
            min_cluster_size=3,
            wall_search_radius_m=1.0,
        )
        self.assertEqual(len(clusters), 1)
        self.assertGreaterEqual(clusters[0].wall_length_m, 1.0)
        self.assertIsNotNone(clusters[0].wall_point)

    def test_left_hand_perimeter_heading_keeps_wall_on_left(self):
        grid = make_grid([[0] * 5 for _ in range(5)])
        cluster = FrontierCluster(
            ((2, 2),),
            (2, 2),
            wall_point=(2.5, 4.5),
            wall_length_m=3.0,
            wall_distance_m=2.0,
            is_exterior=True,
        )
        self.assertAlmostEqual(perimeter_heading(grid, cluster, "left"), 0.0)
        self.assertAlmostEqual(abs(perimeter_heading(grid, cluster, "right")), pi)

    def test_perimeter_selection_rejects_small_obstacle_islands(self):
        grid = make_grid([[0] * 10 for _ in range(5)])
        furniture = FrontierCluster(
            ((3, 2), (3, 3)),
            (3, 2),
            is_exterior=True,
            wall_distance_m=0.5,
            wall_length_m=0.4,
            wall_point=(3.5, 3.0),
        )
        structural_wall = FrontierCluster(
            ((6, 2), (6, 3)),
            (6, 2),
            is_exterior=True,
            wall_distance_m=0.5,
            wall_length_m=2.5,
            wall_point=(6.5, 3.0),
        )
        selected = select_perimeter_frontier(
            grid,
            [furniture, structural_wall],
            robot_position=(1.5, 2.5),
            robot_heading=0.0,
            wall_side="left",
            target_wall_distance_m=0.5,
            wall_distance_tolerance_m=0.15,
            minimum_structural_wall_length_m=1.0,
            perimeter_heading_weight=2.5,
        )
        self.assertEqual(selected, structural_wall)

    def test_perimeter_selection_enforces_wall_distance_band(self):
        grid = make_grid([[0] * 10 for _ in range(5)])
        too_close = FrontierCluster(
            tuple((x, 2) for x in range(2, 7)),
            (4, 2),
            is_exterior=True,
            wall_distance_m=0.25,
            wall_length_m=3.0,
            wall_point=(4.5, 3.0),
        )
        selected = select_perimeter_frontier(
            grid,
            [too_close],
            robot_position=(0.5, 2.5),
            robot_heading=0.0,
            wall_side="left",
            target_wall_distance_m=0.55,
            wall_distance_tolerance_m=0.15,
            minimum_structural_wall_length_m=1.0,
            perimeter_heading_weight=2.5,
        )
        self.assertIsNone(selected)

    def test_perimeter_selection_can_follow_interior_obstacle(self):
        grid = make_grid([[0] * 10 for _ in range(5)])
        interior = FrontierCluster(
            ((4, 2), (4, 3)),
            (4, 2),
            is_exterior=False,
            wall_distance_m=0.5,
            wall_length_m=0.5,
            wall_point=(4.5, 3.0),
        )
        common = dict(
            grid=grid,
            clusters=[interior],
            robot_position=(1.5, 2.5),
            robot_heading=0.0,
            wall_side="left",
            target_wall_distance_m=0.5,
            wall_distance_tolerance_m=0.15,
            minimum_structural_wall_length_m=0.25,
            perimeter_heading_weight=2.5,
        )
        self.assertIsNone(select_perimeter_frontier(**common))
        self.assertEqual(
            select_perimeter_frontier(**common, require_exterior=False), interior
        )

    def test_loop_closure_requires_distance_position_and_heading(self):
        common = dict(
            start_position=(0.0, 0.0),
            start_heading=0.0,
            current_position=(0.2, 0.1),
            current_heading=0.1,
            minimum_travel_m=3.0,
            position_tolerance_m=0.5,
            heading_tolerance_rad=0.52,
        )
        self.assertFalse(loop_is_closed(traveled_m=1.0, **common))
        self.assertTrue(loop_is_closed(traveled_m=4.0, **common))


if __name__ == "__main__":
    unittest.main()
