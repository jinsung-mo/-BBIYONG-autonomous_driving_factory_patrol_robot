from math import pi
import unittest

from bbiyong_explorer.frontier import (
    FrontierCluster,
    GridSpec,
    detect_frontier_clusters,
    reachable_free_cells,
    select_frontier,
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


if __name__ == "__main__":
    unittest.main()
