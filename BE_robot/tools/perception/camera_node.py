#!/usr/bin/env python3
"""카메라 노드 — 화재/연기 탐지 + 라이다가 못 보는 낮은 장애물 탐지.

    python3 camera_node.py [--engine PATH] [--no-trt]

두 가지를 동시에 한다.

1. **화재·연기 탐지** (TensorRT, yolo11n, 클래스 0=smoke 1=fire)
   프로젝트의 임무. 탐지되면 /camera/fire 를 True 로 낸다.

2. 🔴 **낮은 장애물 탐지** (고전 CV, 딥러닝 없음)
   라이다 스캔면은 지상 약 200mm 다. **그보다 낮은 것은 라이다에 안 보인다** —
   신발·전선·문턱·가구 다리. 자율주행 중 이것들이 실제 위험이다.
   바닥은 대체로 균질하므로, 로봇 바로 앞 바닥 색을 기준으로 삼고
   그와 다른 영역을 장애물로 본다(외형 기반 바닥 분할).
   → /camera/floor_clear 로 좌/중/우 3구획의 트임 정도(0~1)를 낸다.

   ⚠️ 카메라 자세 캘리브레이션이 없어 **미터로 환산하지 않는다.**
      "어느 쪽이 얼마나 막혔나"라는 상대값만 낸다. 그거면 회피에 충분하다.

출력
  ROS  /camera/fire (Bool) · /camera/floor_clear (Float32MultiArray[3])
  파일 /tmp/orincar_cam.json  — 대시보드용 (JPEG base64 + 검출 목록)
"""
import argparse
import base64
import json
import math
import os
import sys
import time

import cv2
import numpy as np
import rclpy
from rclpy.node import Node
from std_msgs.msg import Bool, Float32MultiArray, String

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from blackbox_recorder import BlackboxRecorder
from h264_encoder import H264Encoder

CAM_W, CAM_H = 640, 480
H264_HZ = 15.0
DET_HZ = 4.0                 # 화재 탐지 주기 (불은 빨리 안 움직인다)
FLOOR_HZ = 10.0              # 바닥 판정은 주행 안전이라 더 자주
OUT_FILE = "/tmp/orincar_cam.json"

# 화재 판정 — 🔴 검증셋으로 재튜닝할 것. 아래는 현장 오탐 관측으로 잡은 잠정치.
FIRE_CONF_SMOKE = 0.45
FIRE_CONF_FIRE = 0.45
FIRE_M, FIRE_N = 3, 5      # 최근 N회 탐지 중 M회 이상이어야 경보

# ── COCO(80종) 모델 — 주행 중 "무엇인가" 판단 ──────────────────────────
COCO_CONF = 0.40
COCO_NAMES = (
    "person bicycle car motorcycle airplane bus train truck boat "
    "traffic_light fire_hydrant stop_sign parking_meter bench bird cat dog "
    "horse sheep cow elephant bear zebra giraffe backpack umbrella handbag "
    "tie suitcase frisbee skis snowboard sports_ball kite baseball_bat "
    "baseball_glove skateboard surfboard tennis_racket bottle wine_glass cup "
    "fork knife spoon bowl banana apple sandwich orange broccoli carrot "
    "hot_dog pizza donut cake chair couch potted_plant bed dining_table "
    "toilet tv laptop mouse remote keyboard cell_phone microwave oven "
    "toaster sink refrigerator book clock vase scissors teddy_bear "
    "hair_drier toothbrush").split()

# 🔴 생물은 정지, 나머지는 회피. **"밟고 넘어가도 되는 것"은 판정하지 않는다** —
#    박스만으로는 높이를 알 수 없어(바닥의 책 vs 의자 위의 책이 같아 보인다)
#    깊이 센서 없이 그 판단을 하면 위험하다.
LIVING = {"person", "cat", "dog", "bird", "horse", "sheep", "cow", "bear",
          "elephant", "zebra", "giraffe", "teddy_bear"}

# 카메라 수평 화각 — [추정] Brio 100 대각 58° 에서 4:3 환산.
# ⚠️ 라이다로 실측해 확정할 것 (tools/calibration/camera_fov_calib.py).
#    이 값이 틀리면 라이다 거리 매칭이 어긋난다.
CAM_HFOV_DEG = 48.0

# 바닥 기준 패치: 화면 아래 중앙 (로봇 바로 앞)
REF_BOX = (0.40, 0.86, 0.60, 0.98)      # x0,y0,x1,y1 (비율)
ROI_TOP = 0.55                          # 이 아래쪽만 바닥 후보로 본다
FLOOR_TOL = 3.5                         # 기준 바닥 대비 표준편차 몇 배까지 허용
L_WEIGHT = 0.25                         # 밝기 가중 (햇빛·그림자 둔감화). 0.6→0.25


class CameraNode(Node):
    def __init__(self, engine_path, coco_path, use_trt, blackbox=None,
                 h264=None, camera_mode="legacy"):
        super().__init__("camera_node")
        self.cap = cv2.VideoCapture(0)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAM_W)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAM_H)
        self.cap.set(cv2.CAP_PROP_FPS, H264_HZ if camera_mode == "h264" else FLOOR_HZ)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not self.cap.isOpened():
            raise RuntimeError("카메라를 열 수 없다 (/dev/video0)")

        self.model = None          # 화재·연기
        self.coco = None           # COCO 80종
        if use_trt:
            # ⚠️ 추론 래퍼는 **기존 infer_trt.py 를 쓴다.** 한때 같은 기능을
            #    trt_infer.py 로 새로 짰다가 중복임을 발견하고 걷어냈다.
            #    기존 구현은 pycuda·cuda-python 없이 ctypes 로 libcudart 를
            #    직접 부른다 — "Orin 에 패키지를 추가하지 않는다"는 결정에 따른
            #    설계다(infer_trt.py 헤더 참조). 그 결정을 존중한다.
            from infer_trt import TrtModel
            models = [("model", engine_path, "화재")]
            if camera_mode == "legacy":
                models.append(("coco", coco_path, "COCO"))
            for attr, path, label in models:
                try:
                    m = TrtModel(path)
                    setattr(self, attr, m)
                    self.get_logger().info(
                        f"{label} 엔진 로드 {path} · 입력 {m.input_shape}")
                except Exception as e:
                    self.get_logger().warn(f"{label} 엔진 비활성 ({e})")
            if self.model is None and self.coco is None:
                self.get_logger().warn("TensorRT 전부 비활성 — 바닥 탐지만 동작")

        self.pub_fire = self.create_publisher(Bool, "/camera/fire", 10)
        self.pub_floor = self.create_publisher(
            Float32MultiArray, "/camera/floor_clear", 10)
        # 객체 목록은 JSON 문자열로 낸다 — 필드가 유동적이라 커스텀 msg 를
        # 만들 만큼의 안정성이 아직 없다. 안정되면 그때 msg 로 승격.
        self.pub_obj = self.create_publisher(String, "/camera/objects", 10)
        self.objs = []

        self.dets, self.frame = [], None
        self.det_fps, self.last_det = 0.0, 0.0
        # 🔴 M-of-N 시간축 투표. 단일 프레임으로 경보하면 못 쓴다 —
        #    임계값만 낮춰 시험했더니 90초에 오경보 7건이 났고(방에 불 없음),
        #    그때마다 로봇이 멈춰 순찰이 성립하지 않았다.
        #    불은 연속으로 보이지만 오탐은 깜빡인다. 이 차이를 쓴다.
        self.fire_hist = []
        self.blackbox = blackbox
        self.h264 = h264
        self.camera_mode = camera_mode
        if self.camera_mode == "h264":
            self.create_timer(1.0 / H264_HZ, self.tick_h264_capture)
        else:
            self.create_timer(1.0 / FLOOR_HZ, self.tick_floor)
            self.create_timer(1.0 / DET_HZ, self.tick_coco)
        self.create_timer(1.0 / DET_HZ, self.tick_detect)
        self.create_timer(0.5, self.dump)

    # ── 프레임 ──────────────────────────────────────────────────
    def grab(self):
        ok, f = self.cap.read()
        if ok:
            self.frame = f
        return ok

    def tick_h264_capture(self):
        """15 FPS capture path: one x264 encode, no COCO or floor processing."""
        if not self.grab():
            return
        if self.h264 is None:
            return
        try:
            self.h264.add_frame(self.frame)
        except Exception as exc:
            self.get_logger().error(
                f"H.264 encoder disabled; JPEG preview remains available: {exc}"
            )
            try:
                self.h264.close()
            except Exception:
                pass
            self.h264 = None

    # ── 낮은 장애물 (고전 CV) ───────────────────────────────────
    def tick_floor(self):
        if not self.grab():
            return
        img = self.frame
        if self.blackbox is not None:
            try:
                self.blackbox.add_frame(img)
            except Exception as exc:
                self.get_logger().error(f"blackbox recorder disabled: {exc}")
                try:
                    self.blackbox.close()
                except Exception:
                    pass
                self.blackbox = None
        h, w = img.shape[:2]

        # 🔴 영상이 쓸모없으면 **"트임"이 아니라 "모름"을 내야 한다.**
        #    이 알고리즘은 "기준 패치와 다른 영역"을 장애물로 보는데,
        #    화면이 균일하면(렌즈 가림·암흑·과노출) 차이가 0이라
        #    **[1.0, 1.0, 1.0] = 완전히 트임**이 나온다. 실제로 관측됐다.
        #    센서가 죽었을 때 "길이 열렸다"고 말하는 것이 자율주행에서
        #    가장 위험한 실패 모드다.
        #    아무것도 발행하지 않으면 patrol 이 CAM_STALE_S 후 라이다 단독으로
        #    내려간다 — 그 경로가 이미 있으므로 "모름"의 구현은 침묵이면 된다.
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        mean_v, std_v = float(gray.mean()), float(gray.std())
        self.img_ok = not (mean_v < 12 or mean_v > 243 or std_v < 6)
        if not self.img_ok:
            if time.time() - getattr(self, "_blind_log", 0) > 5.0:
                self._blind_log = time.time()
                self.get_logger().warn(
                    f"영상 무효 (밝기 {mean_v:.0f}, 분산 {std_v:.0f}) — "
                    f"바닥 판정 발행 중단. 라이다 단독 주행으로 내려간다. "
                    f"렌즈 가림·조명 확인 필요")
            self.floor_clear = None
            self.dbg_mask = None
            return

        # 🔴 HSV 를 쓰면 안 된다. 바닥이 흰색·회색이면 채도가 0에 가깝고,
        #    그때 **색상(H)은 정의되지 않아 무작위로 튄다**. 흰 바닥끼리
        #    비교해도 거리가 폭발해 전 화면이 장애물로 판정됐다(실측: 좌중우 전부 0).
        #    Lab 은 그 특이점이 없다 — 무채색이면 a·b 가 0 근처로 안정된다.
        lab = cv2.cvtColor(cv2.GaussianBlur(img, (5, 5), 0), cv2.COLOR_BGR2LAB)

        x0, y0, x1, y1 = (int(REF_BOX[0]*w), int(REF_BOX[1]*h),
                          int(REF_BOX[2]*w), int(REF_BOX[3]*h))
        ref = lab[y0:y1, x0:x1].reshape(-1, 3).astype(np.float32)
        if ref.size == 0:
            return
        mu, sd = ref.mean(0), ref.std(0) + 3.0     # 바닥 자체의 얼룩을 허용

        top = int(ROI_TOP * h)
        roi = lab[top:, :, :].astype(np.float32)
        # 🔴 밝기(L) 가중을 크게 낮춘다 — 0.6 → 0.25.
        #    햇빛 반사·그림자는 **L 만 크게 바꾸고 색도(a,b)는 거의 안 바꾼다.**
        #    실제로 바닥에 든 햇빛이 통째로 장애물로 잡히는 것이 관측됐다.
        #    대가: 색도가 같고 밝기만 다른 물체(회색 바닥 위 회색 물건)를 놓친다.
        #    그래도 유리한 거래다 — 햇빛·그림자가 훨씬 흔하고, 키 있는 물체는
        #    라이다가 잡는다. L 을 0 으로 두지 않은 건 아주 어두운 구멍·틈은
        #    잡아야 하기 때문이다.
        d = (roi - mu) / sd
        dist = np.sqrt((d[:, :, 0] * L_WEIGHT) ** 2 + d[:, :, 1] ** 2 + d[:, :, 2] ** 2)
        obstacle = (dist > FLOOR_TOL).astype(np.uint8)
        obstacle = cv2.morphologyEx(obstacle, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        self.dbg_mask = obstacle

        # 좌·중·우 3구획. 아래쪽(=가까운 곳) 행에 가중치를 크게 준다.
        rows = obstacle.shape[0]
        wts = np.linspace(0.3, 1.0, rows)[:, None]
        clear = []
        for k in range(3):
            seg = obstacle[:, k*w//3:(k+1)*w//3]
            blocked = float((seg * wts).sum() / max((np.ones_like(seg)*wts).sum(), 1))
            clear.append(float(np.clip(1.0 - blocked * 2.5, 0.0, 1.0)))
        self.floor_clear = clear
        m = Float32MultiArray()
        m.data = clear
        self.pub_floor.publish(m)

    # ── COCO 80종 (TensorRT) — 주행 중 "무엇인가" ────────────────
    def tick_coco(self):
        if self.frame is None or self.coco is None:
            return
        from infer_trt import preprocess, decode
        img = self.frame
        h, w = img.shape[:2]
        tensor, ratio, pad = preprocess(img, self.coco.input_shape)
        try:
            out = self.coco.infer(tensor)
        except Exception as e:
            self.get_logger().warn(f"COCO 추론 실패: {e}")
            return
        raw = decode(out, ratio, pad, img.shape, candidate_conf=COCO_CONF,
                     nms_iou=0.45, max_det=30)
        objs = []
        # ⚠️ decode() 는 (class_id, score, box[4]) **3-튜플**을 준다.
        #    infer_trt.py 의 docstring 이 "(class_id, score, x1,y1,x2,y2)" 라고
        #    잘못 적혀 있어 6개로 언패킹했다가 노드가 죽었다.
        for c, s, box in raw:
            x1, y1, x2, y2 = (float(v) for v in box)
            name = COCO_NAMES[c] if c < len(COCO_NAMES) else str(c)
            # 박스 중심 x → 방위각. 이 하나가 라이다와 잇는 다리다.
            # 핀홀 근사: tan θ = (u − cx) / f,  f = (w/2) / tan(HFOV/2)
            cx_px = 0.5 * (x1 + x2)
            f = (w / 2.0) / math.tan(math.radians(CAM_HFOV_DEG) / 2.0)
            bearing = math.atan2(cx_px - w / 2.0, f)     # 우측 +
            objs.append({
                "name": name, "conf": round(float(s), 3),
                "box": [round(float(v), 1) for v in (x1, y1, x2, y2)],
                # 라이다 프레임과 부호를 맞춘다(좌 +) — patrol 이 그대로 쓴다
                "bearing": round(-bearing, 4),
                "living": name in LIVING,
                # 화면 아래쪽에 걸칠수록 로봇에 가깝다는 약한 단서
                "bottom": round(float(y2) / h, 3),
            })
        self.objs = objs
        self.pub_obj.publish(String(data=json.dumps(objs)))
        living = [o["name"] for o in objs if o["living"]]
        if living:
            self.get_logger().info(f"생물 감지: {', '.join(sorted(set(living)))}")

    # ── 화재·연기 (TensorRT) ────────────────────────────────────
    def tick_detect(self):
        if self.frame is None or self.model is None:
            return
        from infer_trt import preprocess, decode
        t0 = time.time()
        img = self.frame
        tensor, ratio, pad = preprocess(img, self.model.input_shape)
        try:
            out = self.model.infer(tensor)
        except Exception as e:
            self.get_logger().warn(f"추론 실패: {e}")
            return
        # ⚠️ 임계값은 **검증셋으로 튜닝해야 하는 값**이다. 여기 숫자는 잠정치다.
        #    fire 를 0.20 까지 낮췄더니 오경보가 쏟아졌다(90초 7건).
        #    recall 을 사려고 precision 을 팔면 순찰 로봇은 못 쓴다.
        raw = decode(out, ratio, pad, img.shape,
                     candidate_conf=min(FIRE_CONF_SMOKE, FIRE_CONF_FIRE),
                     nms_iou=0.45, max_det=50)
        thr = (FIRE_CONF_SMOKE, FIRE_CONF_FIRE)
        names = ("smoke", "fire")
        self.dets = [
            {"cls": int(c), "name": names[c] if c < len(names) else str(c),
             "conf": float(s), "box": [float(x1), float(y1), float(x2), float(y2)]}
            for c, s, (x1, y1, x2, y2) in raw
            if s > (thr[c] if c < len(thr) else 0.45)
        ]
        self.det_fps = 1.0 / max(time.time() - t0, 1e-3)

        raw_fire = any(d["cls"] == 1 for d in self.dets)
        self.fire_hist.append(bool(raw_fire))
        if len(self.fire_hist) > FIRE_N:
            self.fire_hist.pop(0)
        fire = sum(self.fire_hist) >= FIRE_M      # N 프레임 중 M 번 이상
        self.pub_fire.publish(Bool(data=bool(fire)))
        if fire:
            self.get_logger().warn(
                f"🔥 화재 확정 ({sum(self.fire_hist)}/{len(self.fire_hist)} 프레임) "
                f"conf={max(d['conf'] for d in self.dets if d['cls']==1):.2f}")

    # ── 대시보드용 파일 ─────────────────────────────────────────
    def dump(self):
        if self.frame is None:
            return
        img = self.frame.copy()
        h, w = img.shape[:2]

        # 바닥 장애물 마스크를 붉게 얹는다. 눈으로 못 보면 임계값 튜닝이 추측이 된다.
        mask = getattr(self, "dbg_mask", None)
        if mask is not None:
            top = h - mask.shape[0]
            sub = img[top:]
            sub[mask > 0] = (0.45 * sub[mask > 0] +
                             0.55 * np.array([60, 60, 235])).astype(np.uint8)
            cv2.line(img, (0, top), (w, top), (90, 90, 90), 1)
            for k in (1, 2):
                cv2.line(img, (k*w//3, top), (k*w//3, h), (90, 90, 90), 1)
        # 바닥 기준 패치 표시
        cv2.rectangle(img, (int(REF_BOX[0]*w), int(REF_BOX[1]*h)),
                      (int(REF_BOX[2]*w), int(REF_BOX[3]*h)), (0, 235, 120), 2)
        fc = getattr(self, "floor_clear", None)
        if fc:
            for k, v in enumerate(fc):
                cv2.putText(img, f"{v:.2f}", (k*w//3 + 12, h - 10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                            (0, 235, 120) if v > 0.5 else (60, 60, 235), 2)

        for o in self.objs:                       # COCO — 생물은 붉게
            x1, y1, x2, y2 = [int(v) for v in o["box"]]
            col = (80, 80, 245) if o["living"] else (120, 220, 120)
            cv2.rectangle(img, (x1, y1), (x2, y2), col, 2)
            cv2.putText(img, f"{o['name']} {o['conf']:.2f}", (x1, max(14, y1-6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1, cv2.LINE_AA)

        for d in self.dets:
            x1, y1, x2, y2 = [int(v) for v in d["box"]]
            col = (60, 60, 235) if d["cls"] == 1 else (200, 200, 60)
            cv2.rectangle(img, (x1, y1), (x2, y2), col, 2)
            cv2.putText(img, f"{d['name']} {d['conf']:.2f}", (x1, max(14, y1-6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1, cv2.LINE_AA)
        # 🔴 축소본을 보내면서 좌표는 원본 기준으로 실으면 받는 쪽이 추측해야 한다.
        #    실제로 대시보드가 박스를 1.6배 어긋나게 그렸다.
        #    → 원본 해상도를 payload 에 함께 실어 보낸다. 캡처 해상도를
        #      바꿔도 소비자가 자동으로 맞춘다.
        src_h, src_w = img.shape[:2]
        OUT_W, OUT_H = 400, 300
        small = cv2.resize(img, (OUT_W, OUT_H))
        ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 62])
        if not ok:
            return
        payload = {
            "t": time.time(),
            # 박스 좌표의 기준 해상도. jpeg 는 out_w×out_h 로 축소돼 있다.
            "src_w": int(src_w), "src_h": int(src_h),
            "out_w": OUT_W, "out_h": OUT_H,
            "jpeg": base64.b64encode(buf.tobytes()).decode("ascii"),
            "dets": self.dets,
            "objs": self.objs,
            "floor_clear": getattr(self, "floor_clear", None),
            "img_ok": bool(getattr(self, "img_ok", True)),
            "det_fps": round(self.det_fps, 1),
            "trt": self.model is not None,
            "coco": self.coco is not None,
        }
        tmp = OUT_FILE + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(payload, f)
            os.replace(tmp, OUT_FILE)     # 원자적 교체
        except OSError:
            pass

    def close(self):
        if self.h264 is not None:
            try:
                self.h264.close()
            except Exception:
                pass
        if self.blackbox is not None:
            try:
                self.blackbox.close()
            except Exception:
                pass
        self.cap.release()
        for m in (self.model, self.coco):
            if m is not None and hasattr(m, "close"):
                try:
                    m.close()
                except Exception:
                    pass


def main():
    ap = argparse.ArgumentParser()
    # 🔴 화재는 s, COCO 는 n — **비대칭이 의도된 것이다.** 실측 근거는
    #    docs/모델_전력_트레이드오프.md.
    #    화재: n 은 fire recall 0.637(불꽃 인스턴스의 36%를 놓친다)이고 s 가
    #      0.657 이다. 비용은 추론 +3.2ms·전력 +57mW 뿐이라 받는 게 맞다.
    #    COCO: s 로 올려도 **오탐이 안 줄어든다.** 같은 40프레임에서 없는
    #      사람을 n 은 40/40, s 는 39/40 프레임에서 봤고(널린 청바지),
    #      s 는 refrigerator·surfboard·suitcase 오탐을 새로 만들었다.
    #      크기 문제가 아니라 도메인 문제다 → 키워도 소용없으니 n 을 유지한다.
    ap.add_argument("--engine",
                    default="/home/e101/models/yolo11s_firesmoke.fp16.engine")
    ap.add_argument("--coco",
                    default="/home/e101/models/yolo11n_coco.fp16.engine")
    ap.add_argument("--no-trt", action="store_true")
    ap.add_argument(
        "--camera-mode",
        choices=("legacy", "h264"),
        default=os.environ.get("ORINCAR_CAMERA_MODE", "legacy"),
        help="legacy keeps floor/COCO/MP4V; h264 uses 640x480@15 without floor/COCO",
    )
    ap.add_argument(
        "--no-blackbox",
        action="store_true",
        default=os.environ.get("ORINCAR_BLACKBOX_ENABLED", "1") == "0",
    )
    ap.add_argument(
        "--blackbox-dir",
        default=os.environ.get(
            "ORINCAR_BLACKBOX_DIR", "~/.local/state/bbiyong/blackbox"
        ),
    )
    ap.add_argument(
        "--blackbox-manifest",
        default=os.environ.get(
            "ORINCAR_BLACKBOX_MANIFEST",
            "~/.local/state/bbiyong/blackbox/manifest.json",
        ),
    )
    ap.add_argument(
        "--blackbox-segment-seconds",
        type=float,
        default=float(os.environ.get("ORINCAR_BLACKBOX_SEGMENT_SECONDS", "10")),
    )
    ap.add_argument(
        "--blackbox-retention-seconds",
        type=float,
        default=float(os.environ.get("ORINCAR_BLACKBOX_RETENTION_SECONDS", "300")),
    )
    ap.add_argument(
        "--h264-frame-file",
        default=os.environ.get("ORINCAR_H264_FRAME_FILE", "/dev/shm/orincar_h264.bin"),
    )
    ap.add_argument(
        "--h264-bitrate-kbps",
        type=int,
        default=int(os.environ.get("ORINCAR_H264_BITRATE_KBPS", "1200")),
    )
    ap.add_argument(
        "--h264-key-interval",
        type=int,
        default=int(os.environ.get("ORINCAR_H264_KEY_INTERVAL", "30")),
    )
    a = ap.parse_args()

    rclpy.init()
    blackbox = None
    h264 = None
    effective_mode = a.camera_mode
    if effective_mode == "h264":
        try:
            h264 = H264Encoder(
                robot_id=os.environ.get("ORINCAR_ROBOT_ID", "orinka_01"),
                frame_file=a.h264_frame_file,
                directory=os.path.join(os.path.expanduser(a.blackbox_dir), "h264"),
                manifest_path=a.blackbox_manifest,
                width=CAM_W,
                height=CAM_H,
                fps=int(H264_HZ),
                bitrate_kbps=a.h264_bitrate_kbps,
                key_interval=a.h264_key_interval,
                segment_seconds=a.blackbox_segment_seconds,
                retention_seconds=a.blackbox_retention_seconds,
                record_enabled=not a.no_blackbox,
            )
        except Exception as exc:
            print(f"[camera] H.264 unavailable, falling back to legacy mode: {exc}", flush=True)
            effective_mode = "legacy"
    if effective_mode == "legacy" and not a.no_blackbox:
        blackbox = BlackboxRecorder(
            cv2,
            a.blackbox_dir,
            a.blackbox_manifest,
            width=CAM_W,
            height=CAM_H,
            fps=FLOOR_HZ,
            segment_seconds=a.blackbox_segment_seconds,
            retention_seconds=a.blackbox_retention_seconds,
        )
    node = CameraNode(
        a.engine,
        a.coco,
        not a.no_trt,
        blackbox=blackbox,
        h264=h264,
        camera_mode=effective_mode,
    )
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.close()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
