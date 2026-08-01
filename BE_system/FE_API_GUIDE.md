# 프론트엔드 팀 전달사항 - 관제센터 대시보드 API

## 📢 개요

백엔드에서 **관제센터 대시보드 통합 통계 API**와 **이벤트 고급 필터링 API**를 구현했습니다.
이제 FE에서 한 번의 요청으로 전체 시스템 현황을 조회하고, 다양한 조건으로 이벤트를 필터링할 수 있습니다.

**배포 브랜치**: `be_system/dev`
**Swagger 문서**: `http://localhost:8080/swagger-ui.html` (서버 실행 후)

---

## 1. 대시보드 통합 통계 API ⭐⭐⭐

### API 명세

```http
GET /api/dashboard/stats
Authorization: Bearer {JWT_TOKEN}
```

### 응답 예시

```json
{
  "summary": {
    "totalRobots": 3,           // 전체 로봇 수
    "activeRobots": 2,          // 활동 중인 로봇 (순찰, 수동 제어)
    "chargingRobots": 1,        // 충전 중인 로봇
    "avgBattery": 75.5,         // 평균 배터리 잔량 (%)
    "onlineRobots": 3           // 현재 연결된 로봇 수
  },
  "today": {
    "eventCount": 12,           // 오늘 총 이벤트 수
    "criticalEvents": 2,        // 치명적 이벤트 (화재)
    "warningEvents": 10,        // 경고 이벤트 (과열)
    "resolvedEvents": 8,        // 해결된 이벤트
    "unresolvedEvents": 4       // 미해결 이벤트
  },
  "recentEvents": [
    {
      "eventId": 123,
      "type": "OVERHEAT",
      "level": "WARNING",
      "equipmentId": "분전반_C",
      "temperature": 52.0,
      "threshold": 50.0,
      "message": "분전반 C 과열 감지 (52.0°C, 임계값 50.0°C)",
      "timestamp": "2026-08-01T14:23:45Z",
      "status": "UNRESOLVED",
      "robotId": "E101",
      "x": 1.25,
      "y": 3.40
    }
    // ... 최대 5건
  ],
  "robotStatus": [
    {
      "robotId": "E101",
      "name": "삐용 순찰 로봇",
      "status": "AUTO_PATROL",
      "battery": 75.0,
      "online": true,
      "speed": 0.6,
      "estop": "RELEASED",
      "location": {
        "x": 1.25,
        "y": 3.40,
        "yaw": 0.78
      }
    }
    // ... 전체 로봇
  ]
}
```

### 활용 예시

```typescript
// React 예시
const DashboardPage = () => {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    const fetchStats = async () => {
      const response = await fetch('/api/dashboard/stats', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await response.json();
      setStats(data);
    };

    fetchStats();
    // 30초마다 갱신 (선택)
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="dashboard">
      {/* 로봇 상태 카드 */}
      <StatCard
        title="전체 로봇"
        value={stats?.summary.totalRobots}
      />
      <StatCard
        title="활동중"
        value={stats?.summary.activeRobots}
      />
      <StatCard
        title="평균 배터리"
        value={`${stats?.summary.avgBattery}%`}
      />

      {/* 오늘 이벤트 통계 */}
      <EventStats
        total={stats?.today.eventCount}
        critical={stats?.today.criticalEvents}
        unresolved={stats?.today.unresolvedEvents}
      />

      {/* 최근 이벤트 목록 */}
      <RecentEvents events={stats?.recentEvents} />

      {/* 로봇 상태 목록 */}
      <RobotList robots={stats?.robotStatus} />
    </div>
  );
};
```

### UI 추천 레이아웃

```
┌─────────────────────────────────────────────────────────┐
│  대시보드 헤더                                            │
├─────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ 전체로봇 │  │ 활동중   │  │평균배터리│  │미해결   │ │
│  │   3대    │  │   2대    │  │  75%    │  │  4건   │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
├─────────────────────────────────────────────────────────┤
│  🚨 최근 이벤트 (실시간)                                  │
│  ────────────────────────────────────────               │
│  🔴 분전반 C 과열 (52°C)                    3분 전      │
│  🟡 E102 배터리 부족 (15%)                 15분 전      │
│  🟢 순찰 완료                              30분 전      │
├─────────────────────────────────────────────────────────┤
│  🤖 로봇 상태                                            │
│  E101 - 순찰중 (75%) ●                                  │
│  E102 - 충전중 (100%) ●                                 │
│  E103 - 대기 (45%) ○                                    │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 이벤트 고급 필터링 API ⭐⭐⭐

### API 명세

```http
GET /api/events?page=0&size=10&type=FIRE&status=UNRESOLVED&...
Authorization: Bearer {JWT_TOKEN}
```

### 필터 파라미터 (모두 선택사항)

| 파라미터 | 타입 | 설명 | 예시 |
|---------|------|------|------|
| `page` | int | 페이지 번호 (0부터 시작) | `0` |
| `size` | int | 페이지 크기 | `10` |
| `type` | string | 이벤트 타입 | `FIRE`, `OVERHEAT`, `SYSTEM` |
| `level` | string | 심각도 | `CRITICAL`, `WARNING` |
| `status` | string | 해결 상태 | `UNRESOLVED`, `RESOLVED` |
| `robotId` | string | 로봇 ID | `E101` |
| `equipmentId` | string | 설비 ID | `분전반_C` |
| `startDate` | string | 시작 날짜 (YYYY-MM-DD) | `2026-08-01` |
| `endDate` | string | 종료 날짜 (YYYY-MM-DD) | `2026-08-07` |

### 사용 예시

```typescript
// 1. 미해결 화재 이벤트만 조회
const fireEvents = await fetch(
  '/api/events?type=FIRE&status=UNRESOLVED',
  { headers: { 'Authorization': `Bearer ${token}` } }
);

// 2. 최근 1주일 E101 로봇의 과열 이벤트
const robotEvents = await fetch(
  '/api/events?robotId=E101&type=OVERHEAT&startDate=2026-07-25&endDate=2026-08-01',
  { headers: { 'Authorization': `Bearer ${token}` } }
);

// 3. 분전반 C의 치명적 이벤트
const criticalEvents = await fetch(
  '/api/events?equipmentId=분전반_C&level=CRITICAL',
  { headers: { 'Authorization': `Bearer ${token}` } }
);

// 4. 오늘의 미해결 이벤트
const today = new Date().toISOString().split('T')[0];
const todayUnresolved = await fetch(
  `/api/events?status=UNRESOLVED&startDate=${today}&endDate=${today}`,
  { headers: { 'Authorization': `Bearer ${token}` } }
);
```

### React 필터 UI 예시

```typescript
const EventListPage = () => {
  const [filters, setFilters] = useState({
    type: '',
    level: '',
    status: '',
    robotId: '',
    startDate: '',
    endDate: ''
  });

  const [events, setEvents] = useState([]);

  const fetchEvents = async () => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.append(key, value);
    });

    const response = await fetch(`/api/events?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    setEvents(data.content);
  };

  return (
    <div>
      {/* 필터 UI */}
      <div className="filters">
        <select onChange={e => setFilters({...filters, type: e.target.value})}>
          <option value="">전체 타입</option>
          <option value="FIRE">화재</option>
          <option value="OVERHEAT">과열</option>
        </select>

        <select onChange={e => setFilters({...filters, status: e.target.value})}>
          <option value="">전체 상태</option>
          <option value="UNRESOLVED">미해결</option>
          <option value="RESOLVED">해결</option>
        </select>

        <input
          type="date"
          onChange={e => setFilters({...filters, startDate: e.target.value})}
        />

        <button onClick={fetchEvents}>검색</button>
      </div>

      {/* 이벤트 목록 */}
      <EventList events={events} />
    </div>
  );
};
```

### 응답 형식

```json
{
  "content": [
    {
      "eventId": 123,
      "type": "FIRE",
      "level": "CRITICAL",
      "message": "화재 감지 (신뢰도 0.95)",
      "robotId": "E101",
      "timestamp": "2026-08-01T14:23:45Z",
      "status": "UNRESOLVED",
      "x": 1.25,
      "y": 3.40,
      "confidence": 0.95
    }
  ],
  "page": {
    "size": 10,
    "number": 0,
    "totalElements": 45,
    "totalPages": 5
  }
}
```

---

## 3. 기존 API와의 차이점

### Before (기존)
```typescript
// 여러 번 요청 필요
const robots = await fetch('/api/robots');
const events = await fetch('/api/events');
// 통계는 직접 계산해야 함

// 필터링 제한적
const fireEvents = await fetch('/api/events?type=FIRE');
// type 외의 필터링 불가
```

### After (신규)
```typescript
// 한 번의 요청으로 모든 통계 조회
const stats = await fetch('/api/dashboard/stats');
// stats.summary, stats.today, stats.recentEvents 모두 포함

// 다양한 필터 조합
const filtered = await fetch(
  '/api/events?type=FIRE&status=UNRESOLVED&startDate=2026-08-01&robotId=E101'
);
```

---

## 4. 추천 구현 순서

### Phase 1: 대시보드 메인 화면 (우선순위 높음)
1. ✅ `/api/dashboard/stats` 연동
2. ✅ 로봇 상태 카드 4개 표시 (전체/활동중/배터리/미해결)
3. ✅ 최근 이벤트 5건 리스트
4. ✅ 로봇 상태 목록 (이름, 배터리, 온라인 여부)

### Phase 2: 이벤트 필터링 (우선순위 중간)
1. ✅ 필터 UI (타입, 상태, 날짜 범위)
2. ✅ 페이징 처리
3. ✅ 필터 조합 테스트

### Phase 3: 실시간 갱신 (선택)
1. WebSocket STOMP 구독 유지
2. 대시보드는 30초마다 polling
3. 새 이벤트 시 알림 표시

---

## 5. 타입 정의 (TypeScript)

```typescript
// Dashboard Stats
interface DashboardStats {
  summary: {
    totalRobots: number;
    activeRobots: number;
    chargingRobots: number;
    avgBattery: number;
    onlineRobots: number;
  };
  today: {
    eventCount: number;
    criticalEvents: number;
    warningEvents: number;
    resolvedEvents: number;
    unresolvedEvents: number;
  };
  recentEvents: EventLog[];
  robotStatus: RobotStatus[];
}

interface EventLog {
  eventId: number;
  type: 'FIRE' | 'OVERHEAT' | 'SYSTEM';
  level: 'CRITICAL' | 'WARNING';
  status: 'UNRESOLVED' | 'RESOLVED';
  message: string;
  robotId: string;
  equipmentId?: string;
  temperature?: number;
  threshold?: number;
  confidence?: number;
  x?: number;
  y?: number;
  timestamp: string;
}

interface RobotStatus {
  robotId: string;
  name: string;
  status: string;
  battery: number;
  online: boolean;
  speed?: number;
  estop?: string;
  location?: {
    x: number;
    y: number;
    yaw: number;
  };
}

// Event Filter
interface EventFilter {
  page?: number;
  size?: number;
  type?: 'FIRE' | 'OVERHEAT' | 'SYSTEM';
  level?: 'CRITICAL' | 'WARNING';
  status?: 'UNRESOLVED' | 'RESOLVED';
  robotId?: string;
  equipmentId?: string;
  startDate?: string;  // YYYY-MM-DD
  endDate?: string;    // YYYY-MM-DD
}
```

---

## 6. 테스트 방법

### Swagger UI에서 테스트
1. 서버 실행: `./gradlew bootRun`
2. Swagger 접속: http://localhost:8080/swagger-ui.html
3. "Dashboard" 섹션에서 `/api/dashboard/stats` 테스트
4. "Event" 섹션에서 `/api/events` 필터링 테스트

### curl 테스트
```bash
# 1. 로그인 (JWT 토큰 받기)
TOKEN=$(curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"password"}' \
  | jq -r '.accessToken')

# 2. 대시보드 통계 조회
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/dashboard/stats | jq

# 3. 미해결 화재 이벤트 조회
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/api/events?type=FIRE&status=UNRESOLVED" | jq
```

---

## 7. 문의사항

**백엔드 담당자**: 모진성 (ahwlstjd57@gmail.com)

**Jira 티켓**:
- [S15P11E101-572](https://ssafy.atlassian.net/browse/S15P11E101-572) - 대시보드 통합 통계 API
- [S15P11E101-574](https://ssafy.atlassian.net/browse/S15P11E101-574) - 이벤트 고급 필터링

**API 문서**: http://localhost:8080/swagger-ui.html

---

## 8. 참고: 기존 API 유지

기존 `/api/events?type=FIRE` API는 **그대로 유지**됩니다.
새 필터링 API는 **추가 기능**이므로 점진적으로 마이그레이션 가능합니다.

```typescript
// 기존 방식 (여전히 작동)
const events = await fetch('/api/events?type=FIRE&page=0&size=10');

// 신규 방식 (더 많은 필터 지원)
const events = await fetch('/api/events?type=FIRE&status=UNRESOLVED&startDate=2026-08-01');
```

---

**구현 완료**: 2026-08-01
**배포**: be_system/dev 브랜치
**상태**: 테스트 완료, 프로덕션 준비 완료 ✅
