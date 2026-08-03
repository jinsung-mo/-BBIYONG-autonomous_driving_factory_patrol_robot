from setuptools import find_packages, setup

package_name = "bbiyong_base"

setup(
    name=package_name,
    version="0.1.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", [f"resource/{package_name}"]),
        (f"share/{package_name}", ["package.xml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="E101",
    maintainer_email="e101@example.com",
    description="Safe command arbitration and Ackermann command conversion for BBIYONG.",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "cmd_mux = bbiyong_base.cmd_mux_node:main",
            "control_command = bbiyong_base.control_command:main",
            "control_state_bridge = bbiyong_base.control_state_bridge:main",
            "manual_drive_bridge = bbiyong_base.manual_drive_bridge:main",
            "ackermann_adapter = bbiyong_base.ackermann_adapter_node:main",
            "differential_adapter = bbiyong_base.differential_adapter_node:main",
            "velocity_floor = bbiyong_base.velocity_floor_node:main",
        ]
    },
)
