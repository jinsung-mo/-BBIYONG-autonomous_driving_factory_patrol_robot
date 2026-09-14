import os
from glob import glob

from setuptools import find_packages, setup

package_name = "bbiyong_bringup"

setup(
    name=package_name,
    version="0.1.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", [f"resource/{package_name}"]),
        (f"share/{package_name}", ["package.xml"]),
        (os.path.join("share", package_name, "launch"), glob("launch/*.launch.py")),
        (os.path.join("share", package_name, "config"), glob("config/*")),
    ],
    install_requires=["setuptools", "PyYAML"],
    zip_safe=True,
    maintainer="E101",
    maintainer_email="e101@example.com",
    description="Launch and configuration tools for BBIYONG SLAM/Nav2.",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "validate_vehicle_config = bbiyong_bringup.vehicle_config:main",
            "generate_nav2_config = bbiyong_bringup.generate_nav2_config:main",
            "save_map = bbiyong_bringup.save_map:main",
            "exploration_map_saver = bbiyong_bringup.exploration_map_saver:main",
            "patrol_route = bbiyong_bringup.patrol_route:main",
            "navigate_goal = bbiyong_bringup.navigate_goal:main",
            "scouting_guard = bbiyong_bringup.scouting_guard:main",
            "trail_layer = bbiyong_bringup.trail_layer:main",
            "commission_check = bbiyong_bringup.commission_check:main",
            "collect_evidence = bbiyong_bringup.commissioning_artifacts:main",
            "release_manager = bbiyong_bringup.release_manager:main",
        ]
    },
)
