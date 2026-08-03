#!/usr/bin/env python3
"""엔진 하나를 고정 이미지셋으로 돌려 지연시간과 검출을 낸다.

    python3 bench_engine.py --engine E.fp16.engine --frames DIR [--names coco|fire]
                            [--conf 0.40] [--repeat 3] [--json out.json]

카메라를 열지 않는다 — 같은 입력을 두 모델에 먹여야 비교가 성립한다.
"""
import argparse, glob, json, os, sys, time
import cv2, numpy as np
from infer_trt import TrtModel, preprocess, decode

COCO = ("person bicycle car motorcycle airplane bus train truck boat "
    "traffic_light fire_hydrant stop_sign parking_meter bench bird cat dog "
    "horse sheep cow elephant bear zebra giraffe backpack umbrella handbag "
    "tie suitcase frisbee skis snowboard sports_ball kite baseball_bat "
    "baseball_glove skateboard surfboard tennis_racket bottle wine_glass cup "
    "fork knife spoon bowl banana apple sandwich orange broccoli carrot "
    "hot_dog pizza donut cake chair couch potted_plant bed dining_table "
    "toilet tv laptop mouse remote keyboard cell_phone microwave oven "
    "toaster sink refrigerator book clock vase scissors teddy_bear "
    "hair_drier toothbrush").split()
FIRE = ["smoke", "fire"]

ap = argparse.ArgumentParser()
ap.add_argument("--engine", required=True)
ap.add_argument("--frames", required=True)
ap.add_argument("--names", default="coco", choices=["coco", "fire"])
ap.add_argument("--conf", type=float, default=0.40)
ap.add_argument("--repeat", type=int, default=3)
ap.add_argument("--json", default=None)
a = ap.parse_args()
names = COCO if a.names == "coco" else FIRE

files = sorted(glob.glob(os.path.join(a.frames, "*.jpg")))
if not files:
    raise SystemExit("no frames in " + a.frames)
imgs = [cv2.imread(f) for f in files]
imgs = [im for im in imgs if im is not None]

m = TrtModel(a.engine)
nc = m.outputs[0]["shape"][1] - 4
pre = [preprocess(im, m.input_shape) for im in imgs]

# 워밍업 — 첫 수 회는 커널 오토튜닝/클럭 램프로 느리다
for _ in range(20):
    m.infer(pre[0][0])

infer_ms, total_ms = [], []
per_frame = []
for r in range(a.repeat):
    for i, im in enumerate(imgs):
        t0 = time.perf_counter()
        tensor, ratio, pad = preprocess(im, m.input_shape)   # 실제 파이프라인 그대로
        t1 = time.perf_counter()
        out = m.infer(tensor)
        t2 = time.perf_counter()
        raw = decode(out, ratio, pad, im.shape, candidate_conf=a.conf,
                     nms_iou=0.45, max_det=30)
        t3 = time.perf_counter()
        infer_ms.append((t2 - t1) * 1000.0)
        total_ms.append((t3 - t0) * 1000.0)
        if r == 0:
            per_frame.append({
                "frame": os.path.basename(files[i]),
                "dets": [{"name": names[c] if c < len(names) else str(c),
                          "conf": round(float(s), 3),
                          "box": [round(float(v), 1) for v in box]}
                         for c, s, box in raw],
            })
m.close()

def st(x):
    s = sorted(x)
    return {"mean": round(sum(x)/len(x), 2), "median": round(s[len(s)//2], 2),
            "p95": round(s[int(0.95*(len(s)-1))], 2), "max": round(s[-1], 2), "n": len(x)}

counts = {}
best = {}
for pf in per_frame:
    for d in pf["dets"]:
        counts[d["name"]] = counts.get(d["name"], 0) + 1
        best[d["name"]] = max(best.get(d["name"], 0.0), d["conf"])
frames_with = {}
for pf in per_frame:
    for n in set(d["name"] for d in pf["dets"]):
        frames_with[n] = frames_with.get(n, 0) + 1

res = {"engine": a.engine, "engine_mb": round(os.path.getsize(a.engine)/1048576, 1),
       "num_classes": nc, "frames": len(imgs), "repeat": a.repeat, "conf": a.conf,
       "infer_ms": st(infer_ms), "pipeline_ms": st(total_ms),
       "infer_fps": round(1000.0/ (sum(infer_ms)/len(infer_ms)), 1),
       "pipeline_fps": round(1000.0/(sum(total_ms)/len(total_ms)), 1),
       "det_counts": counts, "frames_with_class": frames_with, "best_conf": best}
print(json.dumps(res, ensure_ascii=False, indent=2))
if a.json:
    with open(a.json, "w") as f:
        json.dump({"summary": res, "per_frame": per_frame}, f, ensure_ascii=False)
