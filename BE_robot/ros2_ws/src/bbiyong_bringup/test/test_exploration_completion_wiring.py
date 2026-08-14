import ast
from pathlib import Path


PACKAGE = Path(__file__).resolve().parents[1]


def _function(tree, name):
    return next(
        node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == name
    )


def test_map_saver_success_and_final_failure_request_process_exit():
    source = (
        PACKAGE / "bbiyong_bringup" / "exploration_map_saver.py"
    ).read_text(encoding="utf-8")
    tree = ast.parse(source)
    save_source = ast.get_source_segment(source, _function(tree, "_save"))
    assert "self._request_exit(0)" in save_source
    assert save_source.count("self._request_exit(1)") >= 2


def test_map_saver_ignores_stale_completed_sample_until_current_mission_starts():
    source = (
        PACKAGE / "bbiyong_bringup" / "exploration_map_saver.py"
    ).read_text(encoding="utf-8")
    tree = ast.parse(source)
    completed_source = ast.get_source_segment(source, _function(tree, "_completed"))
    assert "self._completion_armed = True" in completed_source
    assert "not self._completion_armed" in completed_source


def test_map_saver_main_owns_shutdown_after_worker_finishes():
    source = (
        PACKAGE / "bbiyong_bringup" / "exploration_map_saver.py"
    ).read_text(encoding="utf-8")
    tree = ast.parse(source)
    main_source = ast.get_source_segment(source, _function(tree, "main"))
    assert "while rclpy.ok() and not node.finished" in main_source
    assert "rclpy.spin_once(node, timeout_sec=0.1)" in main_source
    assert "rclpy.shutdown(context=self.context)" not in source


def test_map_saver_exit_shuts_down_exploration_launch():
    source = (PACKAGE / "launch" / "exploration.launch.py").read_text(
        encoding="utf-8"
    )
    tree = ast.parse(source)
    saver_nodes = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Name) or node.func.id != "Node":
            continue
        keywords = {item.arg: item.value for item in node.keywords if item.arg}
        executable = keywords.get("executable")
        if isinstance(executable, ast.Constant) and executable.value == "exploration_map_saver":
            saver_nodes.append(keywords)
    assert len(saver_nodes) == 1
    on_exit = saver_nodes[0].get("on_exit")
    assert isinstance(on_exit, ast.Call)
    assert isinstance(on_exit.func, ast.Name)
    assert on_exit.func.id == "Shutdown"


def test_exploration_launch_contains_only_mission_nodes():
    source = (PACKAGE / "launch" / "exploration.launch.py").read_text(
        encoding="utf-8"
    )
    tree = ast.parse(source)
    executables = []
    includes = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Name) and node.func.id == "Node":
            keywords = {item.arg: item.value for item in node.keywords if item.arg}
            executable = keywords.get("executable")
            if isinstance(executable, ast.Constant):
                executables.append(executable.value)
        if (
            isinstance(node.func, ast.Name)
            and node.func.id == "IncludeLaunchDescription"
        ):
            includes.append(node)
    assert sorted(executables) == ["exploration_map_saver", "frontier_explorer"]
    assert includes == []


def test_navigation_runtime_owns_nav2_and_command_mux():
    source = (PACKAGE / "launch" / "navigation_runtime.launch.py").read_text(
        encoding="utf-8"
    )
    tree = ast.parse(source)
    assert source.count("navigation_core.launch.py") == 1
    mux_nodes = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not isinstance(node.func, ast.Name) or node.func.id != "Node":
            continue
        keywords = {item.arg: item.value for item in node.keywords if item.arg}
        executable = keywords.get("executable")
        if isinstance(executable, ast.Constant) and executable.value == "cmd_mux":
            mux_nodes.append(node)
    assert len(mux_nodes) == 1


def test_explorer_shutdown_stops_and_cancels_in_flight_goal():
    source = (
        PACKAGE.parent
        / "bbiyong_explorer"
        / "bbiyong_explorer"
        / "exploration_node.py"
    ).read_text(encoding="utf-8")
    tree = ast.parse(source)
    cancel_source = ast.get_source_segment(
        source, _function(tree, "cancel_active_goal")
    )
    assert "self._estop_publisher.publish(Bool(data=True))" in cancel_source
    assert "self._goal_response_future" in cancel_source
    assert "cancel_goal_async()" in cancel_source
    assert "spin_until_future_complete" in cancel_source
