# 학습 없이 수행한 추론 성능 개선 정리

## 1. 목적과 범위

이 문서는 D-Fire 데이터셋으로 이미 학습된 모델을 **재학습하지 않고**, 추론 단계의 결합·임계값·시간적 후처리를 실험한 결과와 실행 방법을 정리한다.

- 목표: smoke와 fire 각각 Precision, Recall `0.80` 이상
- 학습: 수행하지 않음. `.pt` 가중치와 학습 데이터는 수정하지 않음
- 튜닝 데이터: `data/fire_smoke`의 `val` split (3,099장)
- 최종 일반화 평가는 아직 수행하지 않음. `test` split (4,306장)은 최종 1회 평가용으로 남겨 둔다.
- 제외 모델: `yolo26*`

### 사용한 학습 완료 체크포인트

| 역할 | 체크포인트 |
| --- | --- |
| Primary detector | `artifacts/runs/dfire-v1-640-b56-seed42/yolo11n-2/weights/best.pt` |
| Verifier detector | `artifacts/runs/dfire-v1-640-b56-seed42/yolo11s/weights/best.pt` |

두 체크포인트 모두 클래스는 `0: smoke`, `1: fire`다.

## 2. 용어와 전체 설계

`YOLO`는 프레임에서 후보 박스와 confidence를 만든다. 이 프로젝트의 성능 개선은 그 결과를 **버릴지, 다른 모델로 확인할지, 여러 프레임에서 알람으로 확정할지**를 정하는 후처리다.

```text
입력 프레임
  └─ YOLO11n (빠른 primary)
       ├─ 일반 cascade: 불확실한 박스만 YOLO11s로 재확인
       └─ TTA-cascade: YOLO11s를 4개 화면 변형으로 추론 후 합의
              └─ 박스 결합 및 클래스별 threshold 적용
                    └─ 영상에서는 최근 5프레임 중 3회 검출 시 알람
```

### 지표

- Precision: 모델이 fire/smoke라고 말한 것 중 실제 정답 비율. 높을수록 오탐이 적다.
- Recall: 실제 fire/smoke 중 모델이 찾아낸 비율. 높을수록 놓침이 적다.
- F1: Precision과 Recall의 조화평균. 둘 중 하나가 낮으면 크게 낮아진다.
- mAP50: IoU 0.50 기준 박스 탐지 성능. threshold를 고정한 운영 지표와는 구분한다.

## 3. 일반 cascade

구현: `scripts/cascade.py`

1. YOLO11n이 primary 후보를 만든다.
2. confidence가 애매한 후보가 있거나 정해진 주기에 도달하면 YOLO11s verifier를 실행한다.
3. 같은 클래스이고 IoU가 충분히 겹치는 primary/verifier 박스는 confidence의 기하평균과 가중 좌표 평균으로 합친다.
4. 낮은 confidence primary 박스는 verifier 동의가 있어야 통과한다.
5. verifier만 낸 박스는 confidence가 충분히 높을 때만 추가한다.
6. 마지막으로 클래스별 NMS를 적용한다.

### 기본 검증 범위

| 값 | 의미 | 값 |
| --- | --- | --- |
| `verify_low` | verifier 검토 대상 하한 | `0.15` |
| `verify_high` | 일반 runtime에서 불확실성 구간 상한 | `0.60` |
| `primary_conf` | primary 단독 통과 confidence | 실험 기본 `0.25`, 탐색 우수값 `0.35` |
| `agreement_iou` | 두 모델 박스 동의 IoU | 기본 `0.50`, geometry 탐색 우수값 `0.70` |
| `verifier_only_conf` | verifier 단독 박스 추가 최소 confidence | 탐색 우수값 `0.70` |
| `final_nms_iou` | 마지막 클래스별 NMS IoU | geometry 탐색 우수값 `0.35` |
| `verifier_interval` | 강제 verifier 주기 | 일반 runtime 기본 `5`프레임 |

`evaluate_cascade_comparison.py`에서 confidence, agreement IoU, final NMS IoU를 탐색했다. smoke는 일부 조합에서 목표를 달성했지만, fire는 목표에 도달하지 못했다.

## 4. TTA-cascade

### TTA란

TTA(Test-Time Augmentation)는 모델을 새로 학습하지 않고 **입력 하나를 여러 형태로 추론한 뒤 결과가 일치하는지 확인**하는 방법이다.

YOLO11s verifier에 다음 4개 view를 사용했다.

| View | 처리 |
| --- | --- |
| original | 원본 프레임 |
| flip | 좌우 반전 후 박스를 원본 좌표로 복원 |
| dark | gamma `1.20` |
| bright | gamma `0.80` |

각 view의 같은 클래스 박스를 IoU 기준으로 묶고, 다음 둘 중 하나를 만족하면 verifier 결과로 채택한다.

- 서로 다른 view의 투표 수가 `min_votes` 이상
- 해당 클래스의 고신뢰 confidence 이상

### 선택해 본 TTA 합의 값

| 값 | 값 |
| --- | --- |
| `min_votes` | `4` |
| TTA agreement IoU | `0.60` |
| smoke high confidence | `0.65` |
| fire high confidence | `0.75` |

TTA 단독은 fire 오탐이 많아 최종 판정기로는 부적합했다. 따라서 TTA 결과를 YOLO11n의 verifier로만 사용한 것이 TTA-cascade다.

### TTA-cascade 고정 설정

| 구간 | 설정 |
| --- | --- |
| YOLO 입력 크기 | `imgsz=640` |
| 후보 수집 confidence | `0.001` |
| 모델 NMS IoU | `0.70` |
| 최대 후보 박스 | `300` |
| cascade `verify_low` / `verify_high` | `0.15` / `0.60` |
| cascade `primary_conf` | `0.35` |
| cascade agreement IoU | `0.50` |
| verifier-only confidence | `0.70` |
| final NMS IoU | `0.35` |
| smoke 최종 threshold | `0.14` |
| fire 최종 threshold | `0.18` |

마지막 두 threshold는 `val`에서 각 클래스별로 별도 탐색한 값이다. smoke는 목표를 만족했지만 fire는 만족하지 못했으므로, 이를 배포 확정값으로 해석하면 안 된다.

## 5. 검증 결과

### 이미지 단위 평가: D-Fire `val`

평가 결과 파일: `artifacts/evaluations/tta-cascade-val/comparison.json`

| 파이프라인 | Precision | Recall | F1 |
| --- | ---: | ---: | ---: |
| YOLO11n 단독 | 0.7166 | 0.7431 | 0.7296 |
| 일반 cascade 초기값 | 0.7460 | 0.7553 | 0.7506 |
| TTA-cascade | **0.7703** | 0.7441 | **0.7570** |

TTA-cascade의 클래스별 최종 threshold 결과:

| 클래스 | threshold | Precision | Recall | F1 | 목표 P/R 0.80 충족 |
| --- | ---: | ---: | ---: | --- |
| smoke | 0.14 | **0.8028** | **0.8188** | 0.8107 | 예 |
| fire | 0.18 | 0.7082 | 0.7073 | 0.7077 | 아니오 |

결론: **현재까지 전체 F1이 가장 높은 조합은 TTA-cascade**다. 하지만 fire의 Precision과 Recall 모두 `0.80` 목표에 미달했다. 학습 없이, 현재 두 체크포인트와 D-Fire `val` 기준으로는 목표 미달 상태다.

### 중요한 속도 해석

`evaluate_tta_cascade.py`는 이전에 저장한 TTA raw cache를 verifier로 사용한다. 따라서 보고된 primary 추론 시간에는 실제 runtime의 YOLO11s 4-view TTA 비용이 포함되지 않는다.

- 정확도 비교: TTA-cascade가 현재 최고 F1
- 실제 영상 지연시간: YOLO11n 1회 + YOLO11s 4회가 필요하므로 일반 cascade보다 훨씬 느림
- 실시간 후보: 일반 cascade
- 정확도 시연/오프라인 후보: TTA-cascade

## 6. 실행 파일과 사용법

모든 명령은 `AI` 폴더에서 실행한다.

```bash
export PYTHONUTF8=1
```

Git Bash에서 Python의 UTF-8 입출력을 강제해 한글/경로 출력 문제를 줄이는 환경변수다. 학습이나 모델 변경과 무관하다.

### 6.1 일반 cascade 검증

파일: `scripts/evaluate_cascade_comparison.py`

```bash
./.venv/Scripts/python.exe ./scripts/evaluate_cascade_comparison.py \
  --split val \
  --device 0 \
  --imgsz 640 \
  --batch 16 \
  --include-verifier-baseline \
  --tune-class-thresholds \
  --output ./artifacts/evaluations/<새-결과-폴더>
```

YOLO11n, YOLO11s 단독, 일반 cascade를 같은 validation 이미지에서 비교한다. `--output` 폴더는 기존 폴더와 겹치면 안 된다.

### 6.2 TTA 후보 생성: GPU 추론 1회

파일: `scripts/evaluate_tta_consensus.py`

```bash
./.venv/Scripts/python.exe ./scripts/evaluate_tta_consensus.py \
  --split val \
  --device 0 \
  --imgsz 640 \
  --candidate-conf 0.01 \
  --min-votes 3 \
  --agreement-iou 0.50 \
  --high-conf-smoke 0.65 \
  --high-conf-fire 0.60 \
  --min-precision 0.80 \
  --min-recall 0.80 \
  --output ./artifacts/evaluations/<새-tta-캐시-폴더>
```

결과의 `raw_views.json`에는 이미지별 TTA 후보 박스가 저장된다. 이후 TTA 파라미터를 바꿔도 이 캐시를 사용하면 모델 재추론이 필요 없다.

### 6.3 TTA 합의 파라미터 탐색: CPU만 사용

파일: `scripts/tune_tta_consensus.py`

```bash
./.venv/Scripts/python.exe ./scripts/tune_tta_consensus.py \
  --cache ./artifacts/evaluations/tta-consensus-cache-val/raw_views.json \
  --min-precision 0.80 \
  --min-recall 0.80 \
  --output ./artifacts/evaluations/<새-tta-sweep-폴더>
```

`min_votes`, TTA IoU, 클래스별 high confidence, 최종 class threshold를 조합한다. GPU 추론·학습 없이 JSON cache만 읽는다.

### 6.4 TTA-cascade 이미지 평가

파일: `scripts/evaluate_tta_cascade.py`

```bash
./.venv/Scripts/python.exe ./scripts/evaluate_tta_cascade.py \
  --tta-cache ./artifacts/evaluations/tta-consensus-cache-val/raw_views.json \
  --split val \
  --device 0 \
  --imgsz 640 \
  --batch 16 \
  --min-precision 0.80 \
  --min-recall 0.80 \
  --output ./artifacts/evaluations/<새-tta-cascade-폴더>
```

YOLO11n만 새로 실행하고, YOLO11s TTA verifier 결과는 cache에서 읽는다. 이 명령의 결과는 정확도 비교용이며 실제 TTA 영상 속도는 반영하지 않는다.

### 6.5 TTA-cascade 박스/알람 시각화

파일: `scripts/video_tta_cascade.py`

```bash
./.venv/Scripts/python.exe ./scripts/video_tta_cascade.py \
  --source ./data/fire_test1.mp4 \
  --device 0 \
  --imgsz 640 \
  --display-width 720 \
  --display-height 540 \
  --output ./artifacts/video/fire_test1-tta-cascade.mp4
```

- 원본 영상은 수정하지 않고, 박스와 알람이 그려진 MP4를 새로 만든다.
- 화면에는 축소된 preview만 표시되며 저장 MP4는 원본 해상도다.
- `Q`를 누르면 중단한다. 중단 전까지 생성된 MP4는 남는다.
- 프레임마다 YOLO11n 1회와 YOLO11s 4회가 실행되므로 실시간 재생을 기대하면 안 된다.

## 7. 영상 temporal 정책

구현: `scripts/postprocessing.py`의 `FireSmokePostprocessor`

```text
최근 5프레임의 클래스별 검출 이력
  └─ 동일 클래스의 공간적으로 겹치는 검출이 3회 이상이면 alarm 활성화
```

기본 runtime 값은 `window=5`, `min_hits=3`이다. 단일 프레임 오탐을 줄이는 대신, 초기에 나타난 fire/smoke 알람은 최대 2프레임 늦어질 수 있다.

### 라벨 영상 주의점

`data/archive/markup.json`은 모든 영상 프레임이 아니라 **25프레임 간격**으로 라벨이 있다. 따라서 이 파일만으로 temporal `5`는 실제 연속 5프레임이 아니라 약 5초(25fps 가정)의 샘플 5개가 될 수 있다.

- `bucket11.mp4`: fire 양성 라벨이 비교적 많아 시각 점검에 적합
- `printer31.mp4`: smoke 양성 라벨이 비교적 많아 시각 점검에 적합
- `roomfire41.mp4`: 양성 라벨이 적고 정적인 구간이 길어 temporal 성능 평가용으로 부적합

진짜 5 연속 프레임의 Precision/Recall을 측정하려면 모든 처리 프레임에 대한 연속 라벨이 필요하다. `fire_test1.mp4`는 라벨이 확인되지 않았으므로 현재는 정량 평가가 아니라 박스/알람의 시각 점검용이다.

## 8. 현재 상태와 다음 작업

### 현재 확정된 사실

- 재학습 없이 TTA-cascade가 validation aggregate F1 최고값 `0.7570`을 기록했다.
- smoke는 목표를 충족했지만, fire는 현재 어떤 실험에서도 P/R `0.80` 동시 달성에 실패했다.
- TTA-cascade는 정확도 시연용이며, 실시간 성능은 일반 cascade와 별도로 측정해야 한다.

### 다음 권장 순서

1. `fire_test1.mp4`에서 TTA-cascade 박스, confidence, 3/5 알람 타이밍을 시각 확인한다.
2. `bucket11`, `printer31`에서 일반 cascade와 TTA-cascade의 알람 발생 시점을 비교한다.
3. 연속 프레임 라벨 영상이 준비되면 temporal 정책의 window/hits를 별도 평가한다.
4. 최종 파라미터를 확정한 뒤에만 `data/fire_smoke/test`로 단 한 번 최종 평가한다.
