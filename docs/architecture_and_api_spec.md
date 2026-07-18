# 삐용 (BBIYONG) - 시스템 아키텍처 & API 명세 및 Jira 백로그

본 문서는 프로젝트 기획서 및 기능명세서를 바탕으로 설계한 초기 시스템 아키텍처, 통신 프로토콜/API 명세, 그리고 Jira에 즉시 등록하여 사용할 수 있는 1~2주차 티켓 백로그 목록을 정의합니다.

---

## 1. 시스템 아키텍처

삐용(BBIYONG) 프로젝트는 **이벤트 기반 아키텍처(Event-Driven Architecture)**와 **FSM(유한상태머신) 기반 로봇 제어**를 결합하여 설계되었습니다.

### 1.1 아키텍처 다이어그램

```mermaid
graph TD
    subgraph "Robot (Jetson Orin Nano)"
        ROS2[ROS2 Humble / Nav2]
        YOLO[YOLOv11 Detector]
        ThermalNode[Thermal Sensor Node]
        SocketClient[TCP Socket Client]
        
        YOLO -->|Fire Candidate| ThermalNode
        ThermalNode -->|Double Verification Event| SocketClient
        ROS2 -->|Telemetry: Scan/Imu/Odom/Battery| SocketClient
    end

    subgraph "Gateway (Raspberry Pi 5)"
        FastAPI[FastAPI Gateway]
        Mosquitto[Mosquitto MQTT Broker]
        VideoRelay[Video Relay Server]
        
        SocketClient <-->|TCP Socket (JSON Lines)| FastAPI
        SocketClient -->|MQTT Telemetry| Mosquitto
    end

    subgraph "Backend Server (Spring Boot)"
        Spring[Spring Main Server]
        SQLite[(SQLite - Event & Alert DB)]
        Redis[(Redis - Robot Cache)]
        
        FastAPI <-->|WebSocket| Spring
        Spring -->|Read/Write| SQLite
        Spring -->|Cache State| Redis
    end

    subgraph "Web Client (Dashboard / Sim)"
        WebClient[Web Dashboard]
        ThreeJS[Three.js 2D Sim]
        
        Spring <-->|WebSocket / REST| WebClient
        FastAPI -->|HLS/MJPEG Stream| WebClient
        WebClient --> ThreeJS
    end

    classDef robot fill:#ffcccc,stroke:#333,stroke-width:2px;
    classDef gateway fill:#d5f4e6,stroke:#333,stroke-width:2px;
    classDef backend fill:#d1e8ff,stroke:#333,stroke-width:2px;
    classDef web fill:#f9f7d9,stroke:#333,stroke-width:2px;

    class ROS2,YOLO,ThermalNode,SocketClient robot;
    class FastAPI,Mosquitto,VideoRelay gateway;
    class Spring,SQLite,Redis backend;
    class WebClient,ThreeJS web;
```

### 1.2 컴포넌트별 주요 역할

1. **오린카 (Jetson Orin Nano)**:
   * **주행**: LiDAR 센서를 활용해 2D 지도를 작성(SLAM Toolbox)하고, `robot_localization`을 통한 EKF 센서 융합(오도메트리+IMU)으로 자율주행 순찰(Nav2) 및 장애물 회피를 처리합니다.
   * **탐지**: 일반 카메라 영상으로 YOLO 추론을 수행하여 화재 후보를 탐지하고, 열화상 데이터와 대조(이중 판정)하여 비화재 오탐(빛 반사 등)을 원천 차단합니다.
   * **상태**: 순찰 $\leftrightarrow$ 긴급 $\leftrightarrow$ 복귀 상태를 ROS2 FSM 노드로 관리하며, 동작 취소/이동 명령을 처리합니다.
2. **게이트웨이 (Raspberry Pi 5)**:
   * 오린카와는 **TCP 소켓(JSON Lines)**으로 통신하며 명령 및 상태를 실시간 송수신합니다.
   * Spring 메인 서버와는 **WebSocket**을 사용해 로봇 상태와 이중 판정된 긴급 이벤트를 릴레이합니다.
   * 일반 카메라의 실시간 영상을 웹 클라이언트로 스트리밍(Video Relay)합니다.
3. **메인 백엔드 (Spring Boot)**:
   * 로봇의 최종 상태를 **Redis**에 캐싱하고 웹 클라이언트에 **WebSocket**으로 실시간 푸시합니다.
   * 탐지된 이벤트 로그를 **SQLite**에 적재하고 이력을 제공하는 REST API를 제공합니다.
   * 사용자 인증 및 담당 로봇 배정에 따른 권한 제어를 수행합니다.

---

## 2. 초기 API 및 통신 프로토콜 명세

### 2.1 오린카 $\leftrightarrow$ 게이트웨이 (TCP Socket - JSON Lines)

오린카와 라즈베리파이 FastAPI 간에는 매 라인 끝에 `\n` 개행을 포함하는 JSON Lines 규격을 활용합니다.

#### 1) 로봇 상태 전송 (Robot $\rightarrow$ Gateway)
* **주기**: 100ms ~ 500ms 주기
```json
{
  "source": "robot",
  "type": "STATE_UPDATE",
  "robot_id": "orinka_01",
  "location": { "x": 12.34, "y": 5.67, "yaw": 1.57 },
  "battery": 88.5,
  "status": "PATROL",
  "timestamp": 1781778100
}
```

#### 2) 이중 판정 화재 이벤트 전송 (Robot $\rightarrow$ Gateway)
* **주기**: 탐지 시 즉시 전송
```json
{
  "source": "robot",
  "type": "EVENT_FIRE",
  "robot_id": "orinka_01",
  "confidence": 0.92,
  "temperature": 58.4,
  "location": { "x": 15.0, "y": 8.2 },
  "timestamp": 1781778200
}
```

#### 3) 설비 과열 경보 전송 (Robot $\rightarrow$ Gateway)
* **주기**: 기계별 임계값 초과 시 즉시 전송
```json
{
  "source": "robot",
  "type": "EVENT_OVERHEAT",
  "robot_id": "orinka_01",
  "equipment_id": "panel_03",
  "temperature": 65.2,
  "threshold": 60.0,
  "location": { "x": 8.5, "y": 3.1 },
  "timestamp": 1781778300
}
```

#### 4) 긴급 출동 명령 (Gateway $\rightarrow$ Robot)
* **주기**: 이벤트 수신 혹은 웹 수동 지시 시 발행
```json
{
  "command": "DISPATCH",
  "target_location": { "x": 15.0, "y": 8.2 },
  "event_id": "evt_20260718_001"
}
```

#### 5) 복귀 명령 (Gateway $\rightarrow$ Robot)
* **주기**: 상황 종료 후 복귀 지시 시 발행
```json
{
  "command": "RESUME"
}
```

---

### 2.2 메인 서버 (Spring Boot) REST API 명세 (Web Client 용)

| HTTP Method | API Path | 설명 | Request Body / Query | Response Body |
| :--- | :--- | :--- | :--- | :--- |
| **POST** | `/api/auth/login` | 관리자 로그인 | `{"username": "...", "password": "..."}` | `{"token": "JWT_TOKEN", "role": "ADMIN"}` |
| **GET** | `/api/robots` | 관리 권한이 있는 로봇 목록 조회 | None | `[{"robot_id": "orinka_01", "status": "PATROL"}]` |
| **POST** | `/api/robots/{id}/dispatch` | 특정 위치로 로봇 수동 출동 지시 | `{"x": 15.0, "y": 8.2}` | `{"status": "SUCCESS", "message": "Dispatched"}` |
| **POST** | `/api/robots/{id}/resume` | 로봇 복귀 지시 (순찰 재개) | None | `{"status": "SUCCESS", "message": "Resumed"}` |
| **GET** | `/api/events` | 이상 탐지 이벤트 이력 조회 | `?page=0&size=10` | `{"content": [{"event_id": "...", "type": "FIRE", ...}]}` |
| **GET** | `/api/equipments` | 공장 내 설비 정보 및 임계값 조회 | None | `[{"equipment_id": "panel_01", "threshold": 50.0}]` |
| **PUT** | `/api/equipments/{id}` | 특정 설비의 경보 임계 온도 설정 | `{"threshold": 55.0}` | `{"status": "SUCCESS"}` |

---

### 2.3 실시간 웹소켓(WebSocket) 토픽 구조 (Spring Boot $\leftrightarrow$ Web Client)

* **구독 토픽**:
  * `/topic/robots`: 실시간 로봇 위치 및 상태 정보 갱신
  * `/topic/alerts`: 화재/장비 과열 등의 실시간 경보 푸시
* **발행 토픽**:
  * `/app/manual-control`: 웹 대시보드에서 수동 긴급 출동 제어 발행

---

## 3. Jira 티켓 백로그 제안 (1~2주차 대상)

기획서 및 기능명세서의 **4주 WBS와 역할 분담**을 바탕으로, **1~2주차 개발 기간** 동안 Jira에 즉시 등록하여 사용할 수 있는 티켓(Epic/Story/Task) 목록입니다.

### [Epic] EP-01: 개발 환경 및 CI 인프라 구축
> **설명**: 프로젝트 초기 통합 및 가상 검증을 위한 ROS2/Gazebo 환경 및 자동 테스트 인프라를 구축한다.

* **[Task] EP-01-T01: ROS 2 Humble 및 Gazebo 시뮬레이션 환경 구성 (담당: 효준, 재현)**
  * **설명**: Jetson Orin Nano 타겟 환경에 맞춘 ROS 2 Humble 버전 설정 및 로봇 시뮬레이션용 공장 3D 월드(.world) 제작.
  * **완료 기준**: Gazebo 내에서 2D 맵과 간이 로봇이 정상 로드됨.
* **[Task] EP-01-T02: GitHub Actions CI 파이프라인 구성 (담당: 재현)**
  * **설명**: 핵심 경로계획 및 모드 전환 로직 코드를 빌드하고 자동 테스트(pytest / gtest)를 통과시키는 CI 파이프라인 구성.
  * **완료 기준**: PR 오픈 시 빌드 및 테스트 자동 실행 성공.

### [Epic] EP-02: 온디바이스 AI 탐지 모델 개발
> **설명**: 공장 내부 화재/연기 감지 및 설비 온도 모니터링을 위한 AI 모델과 센서 파이프라인을 구축한다.

* **[Story] EP-02-S01: Roboflow 활용 화재/연기 데이터셋 구축 및 YOLO 모델 학습 (담당: 지혁, 재현)**
  * **설명**: 열악한 공장 내부를 가정한 화재/연기 이미지 데이터셋을 증강 학습하고 적절한 모델(YOLO11n, YOLO11s, YOLO26n 중 택1)을 선정한다.
  * **완료 기준**: Test Dataset에 대해 Precision/Recall 85% 이상 달성.
* **[Task] EP-02-T02: ONNX 변환 및 TensorRT 엔진 최적화 배포 (담당: 지혁)**
  * **설명**: 학습된 PyTorch `.pt` 가중치 파일을 ONNX로 변환 후 TensorRT 엔진 파일로 빌드하여 Jetson Orin Nano에 이식한다.
  * **완료 기준**: Jetson Orin Nano 환경에서 FPS 15 이상 달성 확인.

### [Epic] EP-03: 라이다 기반 자율주행 및 위치 추정 개발
> **설명**: 로봇이 공장 지도를 그리고 스스로 자율 순찰을 돌 수 있는 ROS2 네비게이션 스택을 개발한다.

* **[Story] EP-03-S01: SLAM Toolbox 기반 공장 2D 점유 격자 지도(Map) 작성 (담당: 효준)**
  * **설명**: 시뮬레이션 및 실기 환경에서 라이다 센서를 구동해 공장의 2D 맵을 생성하고 저장한다.
  * **완료 기준**: 장애물과 벽이 정밀하게 맵핑된 `.yaml` 및 `.pgm` 파일 저장.
* **[Task] EP-03-T02: robot_localization EKF 센서 융합 및 위치 추정 (담당: 효준)**
  * **설명**: 로봇 휠 오도메트리(Odometry)와 IMU 센서 데이터를 EKF(확장 칼만 필터)로 결합하여 위치 누적 오차를 최소화한다.
  * **완료 기준**: Rviz 상에서 로봇 주행 시 실제 위치와의 미끄러짐 오차 보정 확인.
* **[Task] EP-03-T03: Nav2 기본 순찰 경로 계획 주행 검증 (담당: 효준, 재현)**
  * **설명**: Nav2 스택을 활용하여 사전에 정의된 복수의 순찰 지점(Waypoint)을 동적으로 회피하며 순환 주행하는 기능 구현.
  * **완료 기준**: 순찰 지점 설정 파일 로드 후 1사이클 정상 주행 및 Rviz 가시화.

### [Epic] EP-04: 게이트웨이 및 백엔드 통신 구축
> **설명**: 로봇, 라즈베리파이, 메인 서버, 웹 간의 데이터 흐름을 위한 소켓 및 웹소켓 인터페이스를 구축한다.

* **[Task] EP-04-T01: 로봇 ↔ RP 간 TCP 소켓 서버/클라이언트 구축 (담당: 효준, 승현)**
  * **설명**: JSON Lines 프로토콜 규격에 맞게 FastAPI(FastAPI-SocketIO) 기반 TCP 소켓 서버와 ROS2 파이썬 클라이언트 패키지를 제작한다.
  * **완료 기준**: 소켓 재연결 처리 및 JSON 문자열 파싱 테스트 통과.
* **[Task] EP-04-T02: RP ↔ 메인 서버 ↔ 웹소켓 실시간 텔레메트리 파이프라인 개발 (담당: 예승, 진성)**
  * **설명**: 게이트웨이가 수신한 로봇 상태 데이터를 Spring Boot 메인서버로 전달하고, 메인서버가 이를 WebSocket으로 대시보드에 브로드캐스팅하는 파이프라인 구현.
  * **완료 기준**: 로봇 상태 데이터가 프론트엔드 콘솔 창에 실시간 출력됨.

---

## 4. Jira 티켓 자동 생성 가이드 (Python Script)

Jira API를 연동하여 위의 티켓들을 터미널 명령어 하나로 **Jira 프로젝트에 자동으로 대량 생성**할 수 있는 파이썬 스크립트입니다. 

### 4.1 준비 작업
1. Jira에서 **API Token**을 발급받습니다. (Jira 프로필 설정 -> 보안 -> API 토큰 생성)
2. 아래 스크립트에 본인의 Jira 도메인, 이메일, 발급받은 API 토큰, 그리고 프로젝트 Key를 입력합니다.
3. `/Users/moss/.gemini/antigravity-cli/brain/cd5aeeef-cb21-4b18-8552-69568092b399/scratch/create_jira_tickets.py`에 저장한 뒤 실행합니다.

> [!NOTE]
> 스크립트를 실행하기 전 `pip install jira`를 실행해야 합니다.
