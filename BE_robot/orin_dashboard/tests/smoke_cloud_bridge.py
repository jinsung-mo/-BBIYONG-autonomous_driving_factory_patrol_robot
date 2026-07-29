"""브리지 asyncio/websockets 배선 통합 스모크 테스트 (수동 실행).

가짜 /tmp 파일과 인프로세스 WS 서버를 띄워, 브리지가
  1) 접속 시 REGISTER 를 보내고
  2) TELEMETRY(위치·속도 포함) 를 주기 송신하며
  3) VIDEO_FRAME(FRONT) 를 보내고
  4) 서버가 내려준 DRIVE 명령을 drive.json 으로 떨구는지
를 확인한다. websockets pip 이 필요하므로 unittest 스위트와 분리한다.

실행: python tests/smoke_cloud_bridge.py
"""
import asyncio
import json
import os
import sys
import tempfile

import websockets

TMP = tempfile.mkdtemp(prefix="orincar_smoke_")
NAV = os.path.join(TMP, "nav_live.json")
CAM = os.path.join(TMP, "cam.json")
DRIVE = os.path.join(TMP, "drive.json")
DRIVE_STATUS = os.path.join(TMP, "drive_status.json")

os.environ["ORINCAR_NAV_LIVE_FILE"] = NAV
os.environ["ORINCAR_CAM_FILE"] = CAM
os.environ["ORINCAR_DRIVE_FILE"] = DRIVE
os.environ["ORINCAR_DRIVE_STATUS"] = DRIVE_STATUS

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cloud_bridge  # noqa: E402


def write(path, payload):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f)


async def main():
    import time
    now = time.time()  # fresh() 가 time.time() 기준이라 최신 타임스탬프를 넣는다
    write(NAV, {"t": now, "pose": {"frame": "map", "x": 1.5, "y": -2.0, "yaw": 0.3}})
    write(DRIVE_STATUS, {"t": now, "v": 0.11, "w": 0.0, "patrol_running": False})
    write(CAM, {"t": now, "det_fps": 8.0, "jpeg": "ZmFrZQ==", "dets": []})

    received = []
    ready = asyncio.Event()

    async def handler(ws):
        # 접속 후 DRIVE 명령을 한 번 내려보낸다
        await ws.send(json.dumps({"command": "DRIVE", "linear": 0.2, "angular": -0.1}))
        async for raw in ws:
            received.append(json.loads(raw))
            if len(received) >= 6:
                ready.set()

    server = await websockets.serve(handler, "127.0.0.1", 8791)
    port = server.sockets[0].getsockname()[1]

    class Args:
        server_url = f"ws://127.0.0.1:{port}"
        robot_id = "orinka_test"
        telemetry_hz = 20.0
        video_hz = 20.0

    bridge = cloud_bridge.Bridge(Args())
    task = asyncio.create_task(bridge.run())
    try:
        await asyncio.wait_for(ready.wait(), timeout=5.0)
    finally:
        task.cancel()
        server.close()
        await server.wait_closed()

    types = [p.get("type") for p in received]
    reg = received[0]
    telem = next(p for p in received if p.get("type") == "TELEMETRY")
    video = next((p for p in received if p.get("type") == "VIDEO_FRAME"), None)

    assert reg["type"] == "REGISTER" and reg["robot_id"] == "orinka_test", reg
    assert telem["location"] == {"x": 1.5, "y": -2.0, "yaw": 0.3}, telem
    assert telem["speed"] == 0.11, telem
    assert telem["inferenceFps"] == 8.0, telem
    assert video and video["channel"] == "FRONT" and video["data"] == "ZmFrZQ==", video

    # DRIVE 명령이 drive.json 으로 떨어졌는지
    with open(DRIVE, encoding="utf-8") as f:
        drive = json.load(f)
    assert drive["armed"] is True and drive["v"] == 0.2 and drive["w"] == -0.1, drive

    print("SMOKE OK - types seen:", types)
    print("  telemetry:", telem)
    print("  drive.json:", drive)


if __name__ == "__main__":
    asyncio.run(main())
