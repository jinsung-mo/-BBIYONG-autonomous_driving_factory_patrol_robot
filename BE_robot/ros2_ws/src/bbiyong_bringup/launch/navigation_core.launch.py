from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    share = get_package_share_directory("bbiyong_bringup")
    params = LaunchConfiguration("nav2_params")
    committed_path_bt = f"{share}/config/navigate_to_pose_ackermann.xml"
    common = {
        "output": "screen",
        "parameters": [params],
        "arguments": ["--ros-args", "--log-level", LaunchConfiguration("log_level")],
    }
    lifecycle_nodes = [
        "controller_server",
        "smoother_server",
        "planner_server",
        "behavior_server",
        "bt_navigator",
        "waypoint_follower",
        "velocity_smoother",
        # collision_slowdown_monitor 는 아래에서 띄우지 않으므로 관리 대상에서도 뺀다.
        # 목록에만 남기면 lifecycle_manager 가 오지 않는 노드를 기다리다
        # "Failed to bring up all requested nodes. Aborting bringup." 으로
        # Nav2 전체가 기동에 실패한다. [2026-08-07]
        "collision_monitor",
    ]
        # [2026-08-08] 아래 일반 노드 4개에만 respawn 을 붙였다.
        # 라이프사이클 노드 8개는 lifecycle_manager 가 bond 로 감시하므로 불필요하고,
        # 오히려 해롭다 — respawn 된 노드는 unconfigured 로 돌아오는데
        # lifecycle_manager 는 그걸 모른 채 bond 만 기다린다.
        #
        # 계기: 11:31:22 에 safety_body_filter 가 SIGKILL 됐고 **50분간 아무도
        # 되살리지 않았다**. collision_monitor 의 유일한 입력이 끊긴 채 45회 순찰했다.
        # 명령 사슬은 전부 fail-safe(상류가 죽으면 cmd_mux 데드맨이 정지)인데
        # 이 필터만 fail-open 이다 — 죽어도 로봇은 계속 달리고 안전만 사라진다.
    return LaunchDescription([
        DeclareLaunchArgument("nav2_params"),
        DeclareLaunchArgument(
            "collision_monitor_params",
            default_value=f"{share}/config/collision_monitor.yaml",
        ),
        DeclareLaunchArgument(
            "collision_slowdown_monitor_params",
            default_value=f"{share}/config/collision_slowdown_monitor.yaml",
        ),
        DeclareLaunchArgument(
            "safety_scan_filter_params",
            default_value=f"{share}/config/safety_scan_filter.yaml",
        ),
        DeclareLaunchArgument("log_level", default_value="info"),
        Node(
            package="nav2_controller",
            executable="controller_server",
            name="controller_server",
            remappings=[("cmd_vel", "cmd_vel_nav")],
            **common,
        ),
        Node(package="nav2_smoother", executable="smoother_server", name="smoother_server", **common),
        Node(package="nav2_planner", executable="planner_server", name="planner_server", **common),
        Node(
            package="nav2_behaviors",
            executable="behavior_server",
            name="behavior_server",
            remappings=[("cmd_vel", "cmd_vel_nav")],
            **common,
        ),
        Node(
            package="nav2_bt_navigator",
            executable="bt_navigator",
            name="bt_navigator",
            output="screen",
            parameters=[
                params,
                {"default_nav_to_pose_bt_xml": committed_path_bt},
            ],
            arguments=[
                "--ros-args",
                "--log-level",
                LaunchConfiguration("log_level"),
            ],
        ),
        Node(
            package="nav2_waypoint_follower",
            executable="waypoint_follower",
            name="waypoint_follower",
            **common,
        ),
        Node(
            package="nav2_velocity_smoother",
            executable="velocity_smoother",
            name="velocity_smoother",
            remappings=[
                ("cmd_vel", "cmd_vel_nav"),
                ("cmd_vel_smoothed", "/cmd_vel/autonomy_unfloored"),
            ],
            **common,
        ),
        Node(
            package="bbiyong_base",
            executable="velocity_floor",
            name="bbiyong_velocity_floor",
            respawn=True,
            respawn_delay=2.0,
            output="screen",
            parameters=[{
                # collision_slowdown_monitor 를 제거했으므로 그 출력이 아니라
                # velocity_smoother 의 출력을 직접 받는다. [2026-08-07]
                "input_topic": "/cmd_vel/autonomy_unfloored",
                "output_topic": "/cmd_vel/autonomy_raw",
                "minimum_angular_speed": 0.42,
                "minimum_input_angular_speed": 0.05,
                "linear_epsilon": 0.01,
            }],
        ),
        Node(
            package="laser_filters",
            executable="scan_to_scan_filter_chain",
            name="safety_body_filter",
            respawn=True,
            respawn_delay=2.0,
            output="screen",
            parameters=[LaunchConfiguration("safety_scan_filter_params")],
            remappings=[
                ("scan", "/scan_filtered"),
                ("scan_filtered", "/scan_safety_body"),
            ],
        ),
        # safety_speckle_filter 를 띄우지 않는다. [2026-08-08]
        #
        # 이 노드는 /scan_safety_body -> /scan_safety_confirmed 를 11Hz 로 만드는데,
        # 그 토픽의 **유일한 소비자였던 collision_slowdown_monitor 가 2026-08-07 에
        # 제거됐다**. 지금은 아무도 안 보는 데이터를 만드느라 노드 하나가 돌고,
        # drive_logger 가 그걸 bag 에 녹화까지 하고 있었다.
        # collision_monitor 가 실제로 구독하는 것은 /scan_safety_body 이므로
        # (collision_monitor.yaml) 안전 기능에는 영향이 없다.
        #
        # 되살리려면 collision_slowdown_monitor 복원과 **함께** 이 블록도 되돌린다.
        # 셋(노드 + 이 필터 + slowdown_zone.enabled)이 다 있어야 감속이 동작한다.
        # collision_slowdown_monitor 를 띄우지 않는다. [2026-08-07]
        #
        # 이 노드의 유일한 폴리곤 slowdown_zone 이 `enabled: false` 라서 하는 일이
        # 없는데, 명령 체인에서 가장 느린 단이었다 — /cmd_vel_nav 에서 /cmd_vel 까지
        # 전체 지연 182.7ms 중 86.9ms(48%)를 이 노드가 썼다. 입력을 그대로 출력에
        # 흘리기만 하는 것도 확인했다(2,225 쌍이 비트 단위로 동일).
        # 그 대가로 participant 1 개 · OS 스레드 12 개 · CPU 약 2% 도 함께 썼다.
        #
        # 감속 기능을 되살리려면 이 블록을 복원하고 velocity_floor 의 input_topic 을
        # /cmd_vel/autonomy_slowed 로 되돌린 뒤, collision_slowdown_monitor.yaml 의
        # slowdown_zone.enabled 를 true 로 바꿔야 한다. 셋 중 하나만 해서는 안 된다.
        # 백업: ~/orin-backups/20260807-172638-nav2-bondtimeout-slowdown-removal.tar.gz
        Node(
            package="nav2_collision_monitor",
            executable="collision_monitor",
            name="collision_monitor",
            output="screen",
            parameters=[LaunchConfiguration("collision_monitor_params")],
        ),
        Node(
            package="bbiyong_base",
            executable="escape_recovery",
            name="escape_recovery",
            respawn=True,
            respawn_delay=2.0,
            output="screen",
            parameters=[{
                "stuck_grace_sec": 3.0,
                # 되감기는 시간이 아니라 거리로 보관한다: 끼인 채 오래
                # 서 있어도 진입 경로가 버퍼에 남아 있어야 한다.
                "history_distance_m": 1.0,
                "replay_max_sec": 5.0,
                "max_linear": 0.08,
                "travel_abort_m": 0.12,
                "cooldown_sec": 15.0,
            }],
        ),
        Node(
            package="bbiyong_bringup",
            executable="trail_layer",
            name="trail_layer",
            respawn=True,
            respawn_delay=2.0,
            output="screen",
            parameters=[{
                "map_topic": "/map",
                "trail_topic": "/trail_grid",
                "trail_radius_m": 0.25,
                # 46 에서 경로가 바뀌기 시작한다(실측: calibrate_trail.py,
                # map_20260807_024853 에서 +17% 우회를 감수). 25 는 무반응이었다.
                # 50 -> costmap 127/254 로 내접(253)에 한참 못 미쳐 늘 통과 가능.
                "trail_cost": 50,
                "sample_distance_m": 0.10,
                "decay_tau_sec": 180.0,
                "publish_period_sec": 1.0,
            }],
        ),
        Node(
            package="nav2_lifecycle_manager",
            executable="lifecycle_manager",
            name="lifecycle_manager_navigation",
            output="screen",
            # bond_timeout 을 명시한다. 지정하지 않으면 Nav2 기본값 4.0 초가 쓰이는데,
            # 부하가 걸린 6 코어 임베디드에서 그건 너무 빡빡하다 — 노드가 살아 있는데도
            # 4 초 안에 하트비트를 못 보내면 lifecycle_manager 가 9 개 서버를 통째로
            # 내렸다 올린다. 그 재기동 구간(약 9 초) 동안 bt_navigator 액션이 비활성이라
            # 들어오는 목표를 전부 거부한다.
            #
            # 2026-08-07 실측: 이 강제 재기동이 하루 11 회. 16:52:02 사례에서는
            #   "CRITICAL FAILURE: SERVER collision_slowdown_monitor IS DOWN after not
            #    receiving a heartbeat for 4000 ms. Shutting down related nodes."
            # 직후 9 초간 "Nav2 rejected frontier goal" 이 31 회 찍혔고, 서버가 다시
            # 켜지자 같은 목표가 그대로 수락됐다. 노드는 죽지 않았고 CPU 를 못 받았을
            # 뿐이다(당시 loadavg 10.93, 런큐 52, 컨텍스트 스위치 113k/s).
            parameters=[{
                "autostart": True,
                "node_names": lifecycle_nodes,
                "bond_timeout": 10.0,
            }],
        ),
    ])
