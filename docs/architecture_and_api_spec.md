# 삐용 (BBIYONG) - 시스템 아키텍처 & API 명세

본 문서는 프로젝트 기획서 및 기능명세서를 바탕으로 설계한 초기 시스템 아키텍처 및 통신 프로토콜/API 명세를 정의합니다.

---

## 1. 시스템 아키텍처

삐용(BBIYONG) 프로젝트는 **이벤트 기반 아키텍처(Event-Driven Architecture)**와 **FSM(유한상태머신) 기반 로봇 제어**를 결합하여 설계되었습니다.

### 1.1 아키텍처 다이어그램 (1단계: MVP 개발 단일 아키텍처)

```mermaid
flowchart TD
    subgraph "Robot (Jetson Orin Nano)"
        ROS2[ROS2 Humble / Nav2 / SLAM Toolbox]
        YOLO[YOLOv11 Detector]
        ThermalNode[Thermal Sensor Node]
        WssClient[WSS Client - Python]
        
        YOLO -->|Fire Candidate| ThermalNode
        ThermalNode -->|Cross-Verification: Confirmed Fire| WssClient
        ROS2 -->|Telemetry: Scan/Imu/Odom/Battery/OccupancyGrid| WssClient
        WssClient -->|Manual Drive / Start Mapping: cmd_vel| ROS2
    end

    subgraph "Network & Ingress Layer"
        Nginx[Nginx Reverse Proxy / SSL Termination]
    end

    subgraph "Backend Server (Spring Boot / Raspberry Pi 5)"
        Spring[Spring Main Server :8080]
        WssEndpoint[Robot WebSocket Handler /ws/robot]
        SQLite[SQLite - Event & Alert DB]
        InMemory[In-Memory Cache ConcurrentHashMap]
        
        WssEndpoint -->|Read/Write| SQLite
        WssEndpoint -->|Cache State/Map| InMemory
        Spring --> WssEndpoint
    end

    subgraph "Web Client (Dashboard / Sim)"
        WebClient[Web Dashboard]
        ThreeJS[Three.js 2D Sim / Map Render]
        
        WebClient --> ThreeJS
    end

    %% Flow Connections via Nginx Ingress
    WssClient <-->|1. WSS wss://domain/ws/robot| Nginx
    WebClient <-->|2. HTTPS & STOMP /ws-관제| Nginx
    
    Nginx <-->|Reverse Proxy /ws/robot| WssEndpoint
    Nginx <-->|Reverse Proxy /api & STOMP| Spring

    classDef robot fill:#ffcccc,stroke:#333,stroke-width:2px,color:#333
    classDef backend fill:#d1e8ff,stroke:#333,stroke-width:2px,color:#333
    classDef web fill:#f9f7d9,stroke:#333,stroke-width:2px,color:#333
    classDef ingress fill:#ffe6cc,stroke:#d79b00,stroke-width:2px,color:#333

    class ROS2,YOLO,ThermalNode,WssClient robot
    class Spring,WssEndpoint,SQLite,InMemory backend
    class WebClient,ThreeJS web
    class Nginx ingress
```

### 1.1.1 화재 탐지 및 경보 시퀀스 (로봇 자율 완결형)

고정형 CCTV 없이 **로봇이 순찰 중 스스로 화재를 탐지·검증·보고**하는 자율 완결형 플로우로 설계되었습니다.

```mermaid
flowchart LR
    A[AUTO_PATROL<br/>자율 순찰] -->|YOLO 화재 후보 감지| B[APPROACH<br/>후보 위치로 자율 이동]
    B -->|근접 완료| C[VERIFY<br/>YOLO + 열화상 교차검증]
    C -->|화재 확정| D[경보 전송<br/>EVENT_FIRE → 관제센터]
    C -->|오탐 판정| A
    D --> A
```

* 순찰~검증(`APPROACH`, `VERIFY`) 단계는 로봇의 상태(`status`)로만 관제센터에 실시간 반영되며, **실제 경보(alert)는 교차검증으로 화재가 확정된 시점에만 1회 발송**됩니다(오탐 노이즈 방지).

### 1.2 컴포넌트별 주요 역할

1. **오린카 (Jetson Orin Nano)**:
   * **주행**: LiDAR 센서를 활용해 2D 지도를 작성(SLAM Toolbox)하고, `robot_localization`을 통한 EKF 센서 융합(오도메트리+IMU)으로 자율주행 순찰(Nav2) 및 장애물 회피를 처리합니다.
   * **자율 화재 탐지 (완결형)**: 순찰 중 일반 카메라 영상으로 YOLO 추론을 수행하여 화재 후보를 탐지하면, 스스로 해당 위치 근처로 이동(`APPROACH`)한 뒤 근접 상태에서 YOLO 객체탐지와 열화상(Thermal) 데이터를 대조(교차검증, `VERIFY`)합니다. 화재로 확정된 경우에만 백엔드로 확정 경보(`EVENT_FIRE`)를 전송하여 비화재 오탐(빛 반사 등)을 원천 차단합니다.
   * **온디맨드 2D 도면 매핑**: 관제센터의 매핑 시작 명령(`START_MAPPING`)을 수신하면 `MAPPING` 모드로 진입하여 SLAM 기반 2D 지도를 생성하고, 생성 중인 점유 격자(occupancy grid) 데이터를 WSS로 실시간 스트리밍합니다. 종료 명령(`STOP_MAPPING`) 시 자율 순찰로 복귀합니다.
   * **상태 및 수동 조종**: 자율 순찰(`AUTO_PATROL`) ↔ 수동 조종(`MANUAL_CONTROL`) 등 FSM 전환을 지원합니다. 수동 조종 모드 시 백엔드로부터 WSS 채널로 전달된 WASD 제어 명령을 `/cmd_vel` 토픽으로 변환하여 구동하고, 실시간 비디오 프레임을 릴레이합니다.
2. **Nginx 게이트웨이 & 리버스 프록시 (Ingress Layer)**:
   * 단일 SSL/TLS 인증서 종단점(Termination) 역할을 수행하여 443(HTTPS/WSS) 포트 통신을 전담 처리합니다.
   * 웹 정적 아티팩트(React), 백엔드 REST API(`/api/*`), 웹 관제 웹소켓(`/ws-관제`), 로봇 WSS(`/ws/robot`) 요청을 적절한 내부 포트로 리버스 프록시 라우팅합니다.
3. **메인 백엔드 (Spring Boot / Raspberry Pi 5)**:
   * **로봇 WSS 핸들러 내장**: Nginx로부터 전달받은 WSS 소켓 연결(`/ws/robot`)을 수신하고 명령 및 상태 데이터를 실시간 양방향 송수신합니다.
   * **자율 경보 수신 및 푸시**: 로봇이 교차검증으로 확정한 화재 이벤트(`EVENT_FIRE`)를 수신하면 즉시 SQLite에 이력을 저장하고 STOMP `/topic/alerts` 로 관제 대시보드에 경보를 브로드캐스트합니다.
   * **매핑 제어 및 지도 중계**: 관제 대시보드의 매핑 트리거(`POST /api/robots/{id}/mapping`)를 받아 로봇에 `START_MAPPING`/`STOP_MAPPING` 명령을 전달하고, 로봇이 스트리밍하는 점유 격자 데이터를 STOMP `/topic/map` 으로 대시보드에 실시간 중계합니다.
   * **수동 제어 릴레이**: 웹 브라우저에서 들어오는 실시간 WASD 웹소켓(STOMP) 제어 명령을 로봇의 WSS 소켓 패킷으로 변환하여 실시간 중계합니다.
   * **상태 캐싱 및 실시간 푸시**: 로봇의 실시간 상태를 자바 내장 메모리(**ConcurrentHashMap**)에 캐싱하여 관리 효율을 높이고, 실시간 데이터와 상태를 웹소켓(STOMP)으로 대시보드에 브로드캐스팅합니다.
   * **데이터 저장**: 이벤트 로그와 알림 이력을 SQLite에 저장합니다.

---

### 1.3 Nginx 리버스 프록시 & WSS(WebSocket Secure) 채택 이유

AWS 인프라 환경 및 실제 공장/네트워크 보안 요구사항을 반영하여 **로봇-서버 통신 프로토콜을 Raw TCP에서 WSS(WebSocket Secure)로 채택**하고 **Nginx 리버스 프록시**를 도입하였습니다.

1. **AWS 및 기업 방화벽 통과 (AWS Security Group & NAT Firewall)**:
   * AWS EC2, SSAFY 내부망, 공장 모바일 모뎀(LTE/5G) 방화벽은 9000번 등 임의의 커스텀 TCP 포트 입출력을 엄격히 차단합니다.
   * WSS는 표준 **HTTPS 443번 포트**를 이용하므로 방화벽 설정 변경 없이 100% 정상 통과합니다.
2. **Nginx를 통한 단일 SSL/TLS 인증서 및 엔드포인트 관리**:
   * Nginx가 최전방에서 SSL 종단(TLS Termination)을 담당함으로써 백엔드 애플리케이션의 인증서 처리 부하를 제거하고, 정적 파일/REST API/웹소켓 라우팅을 443 단일 포트로 통합 관리합니다.
3. **종단간(End-to-End) 데이터 암호화 (보안 강화)**:
   * 무선 네트워크(Wi-Fi/LTE) 환경에서 로봇 제어 명령(`cmd_vel`) 및 이상 탐지 데이터의 중간 패킷 도청, 변조(Man-in-the-Middle) 공격을 차단합니다.
4. **AWS ALB / Nginx 웹소켓 업그레이드 호환성**:
   * HTTP 101 Switching Protocols 표준을 준수하여 AWS ALB(L7 로드밸런서) 및 Nginx 환경에서 무중단 실시간 연결 및 로드 밸런싱 처리가 용이합니다.

---

## 2. 초기 API 및 통신 프로토콜 명세

### 2.1 오린카 $\leftrightarrow$ Spring Boot (WebSocket Secure - WSS JSON Protocol)

* **엔드포인트**: `wss://<domain>/ws/robot` (Nginx 리버스 프록시를 통해 Spring Boot 백엔드로 포워딩)
* **데이터 규격**: WebSocket Text Frame 기반 JSON 객체 전송

#### 1) 로봇 상태 및 모드 전송 (Robot $\rightarrow$ Spring Boot)
```json
{
  "source": "robot",
  "type": "STATE_UPDATE",
  "robot_id": "orinka_01",
  "location": { "x": 12.34, "y": 5.67, "yaw": 1.57 },
  "battery": 88.5,
  "status": "AUTO_PATROL",
  "timestamp": 1781778100
}
```
* `status` 항목: `AUTO_PATROL`(자율 순찰), `APPROACH`(화재 후보 위치 자율 접근), `VERIFY`(근접 교차검증), `MANUAL_CONTROL`(직접 조종), `MAPPING`(2D 도면 매핑 중)

#### 2) 교차검증 화재 이벤트 전송 (Robot $\rightarrow$ Spring Boot)
* **설명**: 로봇이 `APPROACH` → `VERIFY`(YOLO 객체탐지 + 열화상)를 거쳐 **화재로 확정한 시점에만** 1회 전송합니다. 후보 감지/접근 단계는 경보가 아닌 `STATE_UPDATE`(status)로만 반영됩니다.
```json
{"source": "robot", "type": "EVENT_FIRE", "robot_id": "orinka_01", "confidence": 0.94, "temperature": 58.4, "location": {"x": 15.0, "y": 8.2}, "timestamp": 1781778200}
```

#### 3) 2D 도면 매핑 점유 격자 스트리밍 (Robot $\rightarrow$ Spring Boot)
* **설명**: `MAPPING` 모드에서 SLAM으로 생성 중인 점유 격자(occupancy grid)를 주기적으로 스트리밍합니다. 백엔드는 이를 STOMP `/topic/map` 으로 대시보드(Three.js)에 중계하여 매핑 진행 상황을 실시간 렌더링합니다.
```json
{
  "source": "robot",
  "type": "MAP_UPDATE",
  "robot_id": "orinka_01",
  "resolution": 0.05,
  "width": 200,
  "height": 200,
  "origin": { "x": -5.0, "y": -5.0 },
  "data": [-1, 0, 0, 100, "...(row-major occupancy: -1 미탐색 / 0 자유 / 100 점유)"],
  "timestamp": 1781778300
}
```

#### 4) 로봇 구동 모드 제어 명령 (Spring Boot $\rightarrow$ Robot)
```json
{"command": "SET_MODE", "mode": "MANUAL_CONTROL"}
```
* `mode` 항목: `AUTO_PATROL` 또는 `MANUAL_CONTROL`

#### 5) 2D 도면 매핑 시작/종료 명령 (Spring Boot $\rightarrow$ Robot)
* **설명**: 관제센터의 매핑 버튼 조작(`POST /api/robots/{id}/mapping`)을 로봇 WSS 명령으로 변환하여 전달합니다. `START_MAPPING` 수신 시 `MAPPING` 모드로 진입해 점유 격자 스트리밍을 시작하고, `STOP_MAPPING` 수신 시 자율 순찰(`AUTO_PATROL`)로 복귀합니다.
```json
{"command": "START_MAPPING"}
```

#### 6) 수동 조종 방향 명령 (Spring Boot $\rightarrow$ Robot)
* **설명**: 웹 관제센터에서 입력한 WASD 키값을 선속도/각속도 값(ROS 2 Twist 메시지 변환용)으로 매핑하여 로봇에 직접 릴레이합니다.
```json
{"command": "DRIVE", "linear": 0.5, "angular": -0.1}
```

---

### 2.2 메인 서버 (Spring Boot) REST API 명세 (Web Client 용)

| HTTP Method | API Path | 설명 | Request Body / Query | Response Body |
| :--- | :--- | :--- | :--- | :--- |
| **POST** | `/api/auth/login` | 관리자 로그인 | `{"username": "...", "password": "..."}` | `{"token": "JWT_TOKEN", "role": "ADMIN"}` |
| **GET** | `/api/robots` | 관리 권한이 있는 로봇 목록 조회 | None | `[{"robot_id": "orinka_01", "status": "AUTO_PATROL"}]` |
| **POST** | `/api/robots/{id}/mode` | 로봇 순찰 모드 변경 (자율순찰/수동조종) | `{"mode": "MANUAL_CONTROL"}` | `{"status": "SUCCESS", "currentMode": "MANUAL_CONTROL"}` |
| **POST** | `/api/robots/{id}/mapping` | 관제센터 2D 도면 매핑 시작/종료 (버튼 트리거 → WSS `START_MAPPING`/`STOP_MAPPING` 중계) | `{"action": "START"}` / `{"action": "STOP"}` | `{"status": "SUCCESS", "currentMode": "MAPPING"}` |
| **GET** | `/api/events` | 이상 탐지 이벤트 이력 조회 (SQLite) | `?page=0&size=10` | `{"content": [{"event_id": 1, "type": "FIRE", ...}]}` |
| **PUT** | `/api/equipments/{id}` | 특정 설비의 경보 임계 온도 설정 | `{"threshold": 55.0}` | `{"status": "SUCCESS"}` |

---

### 2.3 실시간 웹소켓(WebSocket) 토픽 구조 (Spring Boot $\leftrightarrow$ Web Client)

* **구독 토픽 (Sub)**:
  * `/topic/robots`: 실시간 로봇 위치, 모드(`status`: `AUTO_PATROL`/`APPROACH`/`VERIFY`/`MANUAL_CONTROL`/`MAPPING`), 배터리 상태 갱신
  * `/topic/alerts`: 로봇이 교차검증으로 확정한 화재 경보 실시간 푸시
  * `/topic/map`: `MAPPING` 모드 중 로봇이 스트리밍하는 2D 점유 격자(occupancy grid) 실시간 중계 (Three.js 렌더링용)
* **발행 토픽 (Pub)**:
  * `/app/robot/{id}/manual-drive`: 웹 관제화면 WASD 키 입력을 수동 주행 명령으로 변환하여 발행
```json
{
  "linear": 0.5,
  "angular": -0.1
}
```

---

## 3. 점진적 아키텍처 확장 로드맵 (포트폴리오 고도화 전략)

본 프로젝트는 4주 개발 일정을 고려해 **1단계: Spring Boot 단일 백엔드 아키텍처**로 구현을 시작하여 신속하게 MVP를 완성합니다. 이후 추가적인 성능 고도화 및 이종 백엔드 기술 경험(포트폴리오 강화)을 위해 **2단계: FastAPI 게이트웨이 분리 아키텍처**로 진화하는 로드맵을 설계했습니다.

```mermaid
flowchart LR
    subgraph "Phase 1: MVP (Fast Development)"
        Robot1[Robot]
        SpringBoot1[Spring Boot + SQLite]
        Robot1 <-->|Direct TCP Socket| SpringBoot1
    end
    
    subgraph "Phase 2: Scale-out & Hybrid Tech (Portfolio)"
        Robot2[Robot]
        FastAPI[FastAPI Gateway Python]
        SpringBoot2[Spring Boot + SQLite]
        Robot2 <-->|TCP Socket / Media Relay| FastAPI
        FastAPI <-->|WebSocket / gRPC| SpringBoot2
    end

    SpringBoot1 -.->|Architecture Expansion| FastAPI

    classDef robot fill:#ffcccc,stroke:#333,stroke-width:2px,color:#333
    classDef backend fill:#d1e8ff,stroke:#333,stroke-width:2px,color:#333
    classDef gateway fill:#e1d5e7,stroke:#333,stroke-width:2px,color:#333

    class Robot1,Robot2 robot
    class SpringBoot1,SpringBoot2 backend
    class FastAPI gateway
```

### 2단계 확장 시 이점 (포트폴리오 가치)
1. **비디오 스트리밍 오버헤드 분리**: OpenCV/Media 가공 능력이 뛰어난 파이썬 기반 FastAPI 게이트웨이를 독립시킴으로써, 자바/Spring Boot 메인 서버는 비즈니스 로직과 웹소켓 알림 처리에만 전념하도록 CPU 연산 부하를 차단합니다.
2. **이종 백엔드(Hybrid Backend) 협업 경험**: 대규모 분산환경에서 사용되는 Gateway 패턴을 직접 설계하고 구현하여, 자바와 파이썬이라는 이종 플랫폼 간의 네트워크 통신(gRPC 또는 WebSocket) 정합성 처리 경험을 증명합니다.


