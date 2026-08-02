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
