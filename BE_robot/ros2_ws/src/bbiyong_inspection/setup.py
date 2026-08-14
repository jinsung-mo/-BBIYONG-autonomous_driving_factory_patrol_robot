import os
from glob import glob

from setuptools import find_packages, setup


package_name = "bbiyong_inspection"


setup(
    name=package_name,
    version="0.1.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", [f"resource/{package_name}"]),
        (f"share/{package_name}", ["package.xml", "README.md"]),
        (os.path.join("share", package_name, "config"), glob("config/*.yaml")),
        (os.path.join("share", package_name, "launch"), glob("launch/*.launch.py")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="E101",
    maintainer_email="e101@example.com",
    description="AprilTag wall pings and safe Nav2 inspection patrol missions.",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "apriltag_detector = bbiyong_inspection.apriltag_detector:main",
            "apriltag_smoke_test = bbiyong_inspection.apriltag_smoke_test:main",
            "wall_ping_projector = bbiyong_inspection.wall_ping_projector:main",
            "inspection_point_manager = bbiyong_inspection.inspection_point_manager:main",
            "inspection_patrol = bbiyong_inspection.inspection_patrol:main",
            "fire_inspection = bbiyong_inspection.fire_inspection:main",
        ]
    },
)
