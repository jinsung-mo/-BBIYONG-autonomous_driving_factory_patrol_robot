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
    install_requires=["setuptools", "websocket-client"],
    zip_safe=True,
    maintainer="E101",
    maintainer_email="e101@example.com",
    description="Safe command arbitration and Ackermann command conversion for BBIYONG.",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "cmd_mux = bbiyong_base.cmd_mux_node:main",
            "ackermann_adapter = bbiyong_base.ackermann_adapter_node:main",
            "remote_control_bridge = bbiyong_base.remote_control_bridge_node:main",
        ]
    },
)
