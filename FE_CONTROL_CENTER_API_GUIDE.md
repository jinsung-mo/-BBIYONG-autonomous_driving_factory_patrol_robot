# 관제센터 API 가이드 (Control Center APIs)

프론트엔드 팀을 위한 관제센터 기능 API 통합 가이드입니다.

## 📋 목차

1. [대시보드 통계 API](#1-대시보드-통계-api)
2. [이벤트 필터링 API](#2-이벤트-필터링-api)
3. [Mattermost 알림 설정 API](#3-mattermost-알림-설정-api)
4. [자동 순찰 스케줄러 API](#4-자동-순찰-스케줄러-api)
5. [로봇 건강 이력 API](#5-로봇-건강-이력-api)
6. [이벤트 통계 차트 API](#6-이벤트-통계-차트-api)
7. [TypeScript 타입 정의](#7-typescript-타입-정의)
8. [React 예제 코드](#8-react-예제-코드)

---

## 1. 대시보드 통계 API

### GET `/api/dashboard/stats`

관제센터 메인 대시보드에 필요한 모든 통계를 한 번의 요청으로 조회합니다.

**요청 예시:**
```typescript
const response = await fetch('/api/dashboard/stats', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
const data = await response.json();
```

**응답 예시:**
```json
{
  "summary": {
    "totalRobots": 5,
    "activeRobots": 3,
    "chargingRobots": 1,
    "avgBattery": 78.5,
    "onlineRobots": 4
  },
  "today": {
    "eventCount": 12,
    "criticalEvents": 2,
    "warningEvents": 10,
    "resolvedEvents": 8,
    "unresolvedEvents": 4
  },
  "recentEvents": [
    {
      "eventId": 123,
      "type": "FIRE",
      "level": "CRITICAL",
      "message": "화재 감지: 신뢰도 95%",
      "robotId": "robot-001",
      "x": 10.5,
      "y": 20.3,
      "confidence": 0.95,
      "timestamp": "2026-08-01T10:30:00Z",
      "status": "UNRESOLVED"
    }
  ],
  "robotStatus": [
    {
      "robotId": "robot-001",
      "name": "Patrol Robot 1",
      "status": "AUTO_PATROL",
      "battery": 85.0,
      "speed": 0.5,
      "estop": "NONE",
      "commLatencyMs": 45,
      "inferenceFps": 30.0,
      "lastConnected": "2026-08-01T10:35:00Z",
      "location": {"x": 10.5, "y": 20.3, "yaw": 45.0},
      "online": true
    }
  ]
}
```

---

## 2. 이벤트 필터링 API

### GET `/api/events`

다양한 조건으로 이벤트를 필터링하여 조회합니다.

**쿼리 파라미터:**
- `page`: 페이지 번호 (기본값: 0)
- `size`: 페이지 크기 (기본값: 10)
- `type`: 이벤트 타입 (`FIRE`, `OVERHEAT`, `SYSTEM`)
- `level`: 심각도 (`CRITICAL`, `WARNING`)
- `status`: 해결 상태 (`UNRESOLVED`, `RESOLVED`)
- `robotId`: 특정 로봇 ID
- `equipmentId`: 특정 설비 ID
- `startDate`: 시작 날짜 (YYYY-MM-DD)
- `endDate`: 종료 날짜 (YYYY-MM-DD)

**요청 예시:**
```typescript
const params = new URLSearchParams({
  page: '0',
  size: '20',
  type: 'FIRE',
  level: 'CRITICAL',
  status: 'UNRESOLVED',
  startDate: '2026-08-01'
});

const response = await fetch(`/api/events?${params}`, {
  headers: {'Authorization': `Bearer ${token}`}
});
```

**응답 예시:**
```json
{
  "content": [
    {
      "eventId": 123,
      "type": "FIRE",
      "level": "CRITICAL",
      "message": "화재 감지: 신뢰도 95%",
      "robotId": "robot-001",
      "x": 10.5,
      "y": 20.3,
      "confidence": 0.95,
      "timestamp": "2026-08-01T10:30:00Z",
      "status": "UNRESOLVED"
    }
  ],
  "totalElements": 50,
  "totalPages": 3,
  "size": 20,
  "number": 0
}
```

---

## 3. Mattermost 알림 설정 API

### GET `/api/notifications/settings`

현재 사용자의 Mattermost 알림 설정을 조회합니다.

**응답 예시:**
```json
{
  "mattermostEnabled": true,
  "mattermostWebhookUrl": "https://mattermost.example.com/hooks/xxx",
  "mattermostChannel": "alerts",
  "minSeverity": "WARNING"
}
```

### PUT `/api/notifications/settings`

Mattermost 알림 설정을 업데이트합니다.

**요청 예시:**
```typescript
const response = await fetch('/api/notifications/settings', {
  method: 'PUT',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    mattermostEnabled: true,
    mattermostWebhookUrl: 'https://mattermost.example.com/hooks/xxx',
    mattermostChannel: 'alerts',
    minSeverity: 'CRITICAL'
  })
});
```

**minSeverity 옵션:**
- `CRITICAL`: CRITICAL 이벤트만 알림
- `WARNING`: WARNING 이상 (WARNING + CRITICAL) 알림

---

## 4. 자동 순찰 스케줄러 API

### GET `/api/patrol-schedules`

모든 순찰 스케줄을 조회합니다.

**쿼리 파라미터:**
- `robotId` (선택): 특정 로봇의 스케줄만 조회

**응답 예시:**
```json
[
  {
    "scheduleId": 1,
    "name": "주간 순찰",
    "robotId": "robot-001",
    "cronExpression": "0 0 9 * * MON-FRI",
    "enabled": true,
    "lastExecuted": "2026-08-01T09:00:00Z",
    "createdAt": "2026-07-01T00:00:00Z",
    "updatedAt": "2026-07-01T00:00:00Z"
  }
]
```

### POST `/api/patrol-schedules`

새 스케줄을 생성합니다.

**요청 예시:**
```typescript
const response = await fetch('/api/patrol-schedules', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: '주간 순찰',
    robotId: 'robot-001',
    cronExpression: '0 0 9 * * MON-FRI', // 평일 오전 9시
    enabled: true
  })
});
```

**Cron 표현식 예시:**
- `0 0 9 * * MON-FRI`: 평일 오전 9시
- `0 0 */6 * * *`: 6시간마다
- `0 0 0 * * *`: 매일 자정
- `0 30 14 * * SAT`: 매주 토요일 오후 2시 30분

### PUT `/api/patrol-schedules/{scheduleId}`

기존 스케줄을 수정합니다.

### DELETE `/api/patrol-schedules/{scheduleId}`

스케줄을 삭제합니다.

---

## 5. 로봇 건강 이력 API

### GET `/api/robots/{robotId}/health-history`

특정 로봇의 건강 상태 이력을 조회합니다. (차트용)

**쿼리 파라미터:**
- `period`: 조회 기간 (기본값: `24h`)
  - 시간 단위: `1h`, `6h`, `24h`
  - 일 단위: `7d`, `30d`

**요청 예시:**
```typescript
const response = await fetch('/api/robots/robot-001/health-history?period=24h', {
  headers: {'Authorization': `Bearer ${token}`}
});
```

**응답 예시:**
```json
{
  "robotId": "robot-001",
  "startTime": "2026-07-31T10:00:00Z",
  "endTime": "2026-08-01T10:00:00Z",
  "dataPoints": [
    {
      "timestamp": "2026-07-31T10:00:00Z",
      "battery": 85.0,
      "speed": 0.5,
      "commLatencyMs": 45,
      "inferenceFps": 30.0,
      "status": "AUTO_PATROL",
      "estop": "NONE",
      "online": true
    },
    {
      "timestamp": "2026-07-31T10:01:00Z",
      "battery": 84.9,
      "speed": 0.5,
      "commLatencyMs": 47,
      "inferenceFps": 29.8,
      "status": "AUTO_PATROL",
      "estop": "NONE",
      "online": true
    }
  ]
}
```

**차트 렌더링 팁:**
- `dataPoints` 배열은 시간 순으로 정렬되어 있습니다
- X축: `timestamp`
- Y축: `battery`, `commLatencyMs`, `inferenceFps` 등

---

## 6. 이벤트 통계 차트 API

### GET `/api/events/stats/hourly`

시간별 이벤트 발생 통계를 조회합니다.

**쿼리 파라미터:**
- `hours`: 조회할 시간 범위 (기본값: 24)

**응답 예시:**
```json
{
  "groupBy": "hour",
  "startTime": "2026-07-31T10:00:00Z",
  "endTime": "2026-08-01T10:00:00Z",
  "dataPoints": [
    {
      "label": "10:00",
      "timestamp": "2026-07-31T10:00:00Z",
      "totalCount": 5,
      "criticalCount": 1,
      "warningCount": 4,
      "unresolvedCount": 3,
      "resolvedCount": 2
    },
    {
      "label": "11:00",
      "timestamp": "2026-07-31T11:00:00Z",
      "totalCount": 3,
      "criticalCount": 0,
      "warningCount": 3,
      "unresolvedCount": 1,
      "resolvedCount": 2
    }
  ]
}
```

### GET `/api/events/stats/daily`

일별 이벤트 발생 통계를 조회합니다.

**쿼리 파라미터:**
- `days`: 조회할 일수 (기본값: 7)

**응답 형식:** 시간별과 동일 (label 형식만 "MM/DD"로 변경)

### GET `/api/events/stats/by-robot`

로봇별 이벤트 발생 통계를 조회합니다.

**쿼리 파라미터:**
- `days`: 조회할 일수 (기본값: 7)

**응답 예시:**
```json
{
  "groupBy": "robot",
  "startTime": "2026-07-25T00:00:00Z",
  "endTime": "2026-08-01T10:00:00Z",
  "dataPoints": [
    {
      "label": "robot-001",
      "timestamp": null,
      "totalCount": 25,
      "criticalCount": 5,
      "warningCount": 20,
      "unresolvedCount": 10,
      "resolvedCount": 15
    },
    {
      "label": "robot-002",
      "timestamp": null,
      "totalCount": 18,
      "criticalCount": 3,
      "warningCount": 15,
      "unresolvedCount": 7,
      "resolvedCount": 11
    }
  ]
}
```

### GET `/api/events/stats/by-equipment`

설비별 과열 이벤트 통계를 조회합니다.

### GET `/api/events/stats/by-type`

이벤트 타입별 통계를 조회합니다.

---

## 7. TypeScript 타입 정의

```typescript
// Dashboard
interface DashboardStatsResponse {
  summary: RobotSummary;
  today: TodayStats;
  recentEvents: EventLog[];
  robotStatus: RobotResponse[];
}

interface RobotSummary {
  totalRobots: number;
  activeRobots: number;
  chargingRobots: number;
  avgBattery: number;
  onlineRobots: number;
}

interface TodayStats {
  eventCount: number;
  criticalEvents: number;
  warningEvents: number;
  resolvedEvents: number;
  unresolvedEvents: number;
}

// Events
interface EventLog {
  eventId: number;
  type: 'FIRE' | 'OVERHEAT' | 'SYSTEM';
  level: 'CRITICAL' | 'WARNING';
  message: string;
  robotId?: string;
  equipmentId?: string;
  x?: number;
  y?: number;
  confidence?: number;
  temperature?: number;
  threshold?: number;
  timestamp: string; // ISO 8601
  status: 'UNRESOLVED' | 'RESOLVED';
}

interface EventPageResponse {
  content: EventLog[];
  totalElements: number;
  totalPages: number;
  size: number;
  number: number;
}

// Notifications
interface NotificationSetting {
  mattermostEnabled: boolean;
  mattermostWebhookUrl?: string;
  mattermostChannel?: string;
  minSeverity: 'CRITICAL' | 'WARNING';
}

// Patrol Schedules
interface PatrolSchedule {
  scheduleId: number;
  name: string;
  robotId: string;
  cronExpression: string;
  enabled: boolean;
  lastExecuted?: string;
  createdAt: string;
  updatedAt: string;
}

interface PatrolScheduleRequest {
  name: string;
  robotId: string;
  cronExpression: string;
  enabled: boolean;
}

// Robot Health History
interface RobotHealthHistoryResponse {
  robotId: string;
  startTime: string;
  endTime: string;
  dataPoints: HealthDataPoint[];
}

interface HealthDataPoint {
  timestamp: string;
  battery?: number;
  speed?: number;
  commLatencyMs?: number;
  inferenceFps?: number;
  status?: string;
  estop?: string;
  online?: boolean;
}

// Event Statistics
interface EventStatsResponse {
  groupBy: 'hour' | 'day' | 'robot' | 'equipment' | 'type';
  startTime: string;
  endTime: string;
  dataPoints: EventStatsDataPoint[];
}

interface EventStatsDataPoint {
  label: string;
  timestamp?: string | null;
  totalCount: number;
  criticalCount: number;
  warningCount: number;
  unresolvedCount: number;
  resolvedCount: number;
}

// Robot
interface RobotResponse {
  robotId: string;
  name: string;
  status: string;
  battery?: number;
  speed?: number;
  estop?: string;
  commLatencyMs?: number;
  inferenceFps?: number;
  lastConnected?: string;
  location?: Location;
  online?: boolean;
}

interface Location {
  x: number;
  y: number;
  yaw: number;
}
```

---

## 8. React 예제 코드

### 대시보드 컴포넌트

```typescript
import React, { useEffect, useState } from 'react';

const Dashboard: React.FC = () => {
  const [stats, setStats] = useState<DashboardStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDashboardStats = async () => {
      try {
        const response = await fetch('/api/dashboard/stats', {
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('token')}`
          }
        });
        const data = await response.json();
        setStats(data);
      } catch (error) {
        console.error('Failed to fetch dashboard stats:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchDashboardStats();
    // 30초마다 갱신
    const interval = setInterval(fetchDashboardStats, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading || !stats) return <div>Loading...</div>;

  return (
    <div className="dashboard">
      <div className="summary-cards">
        <Card title="전체 로봇" value={stats.summary.totalRobots} />
        <Card title="가동 중" value={stats.summary.activeRobots} />
        <Card title="평균 배터리" value={`${stats.summary.avgBattery}%`} />
        <Card title="오늘 이벤트" value={stats.today.eventCount} />
      </div>

      <div className="recent-events">
        <h3>최근 이벤트</h3>
        {stats.recentEvents.map(event => (
          <EventItem key={event.eventId} event={event} />
        ))}
      </div>

      <div className="robot-status">
        <h3>로봇 상태</h3>
        {stats.robotStatus.map(robot => (
          <RobotStatusItem key={robot.robotId} robot={robot} />
        ))}
      </div>
    </div>
  );
};
```

### 이벤트 필터 컴포넌트

```typescript
import React, { useState, useEffect } from 'react';

interface EventFilters {
  type?: string;
  level?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
}

const EventLogTable: React.FC = () => {
  const [events, setEvents] = useState<EventPageResponse | null>(null);
  const [filters, setFilters] = useState<EventFilters>({});
  const [page, setPage] = useState(0);

  useEffect(() => {
    fetchEvents();
  }, [filters, page]);

  const fetchEvents = async () => {
    const params = new URLSearchParams({
      page: page.toString(),
      size: '20',
      ...filters
    });

    const response = await fetch(`/api/events?${params}`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });
    const data = await response.json();
    setEvents(data);
  };

  return (
    <div>
      <div className="filters">
        <select onChange={(e) => setFilters({...filters, type: e.target.value})}>
          <option value="">모든 타입</option>
          <option value="FIRE">화재</option>
          <option value="OVERHEAT">과열</option>
          <option value="SYSTEM">시스템</option>
        </select>

        <select onChange={(e) => setFilters({...filters, level: e.target.value})}>
          <option value="">모든 심각도</option>
          <option value="CRITICAL">긴급</option>
          <option value="WARNING">경고</option>
        </select>

        <select onChange={(e) => setFilters({...filters, status: e.target.value})}>
          <option value="">모든 상태</option>
          <option value="UNRESOLVED">미해결</option>
          <option value="RESOLVED">해결</option>
        </select>
      </div>

      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>타입</th>
            <th>심각도</th>
            <th>메시지</th>
            <th>로봇</th>
            <th>시간</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          {events?.content.map(event => (
            <tr key={event.eventId}>
              <td>{event.eventId}</td>
              <td>{event.type}</td>
              <td>{event.level}</td>
              <td>{event.message}</td>
              <td>{event.robotId}</td>
              <td>{new Date(event.timestamp).toLocaleString()}</td>
              <td>{event.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Pagination
        currentPage={page}
        totalPages={events?.totalPages || 0}
        onPageChange={setPage}
      />
    </div>
  );
};
```

### 로봇 건강 이력 차트

```typescript
import React, { useEffect, useState } from 'react';
import { Line } from 'react-chartjs-2';

const RobotHealthChart: React.FC<{ robotId: string }> = ({ robotId }) => {
  const [healthData, setHealthData] = useState<RobotHealthHistoryResponse | null>(null);

  useEffect(() => {
    const fetchHealthHistory = async () => {
      const response = await fetch(`/api/robots/${robotId}/health-history?period=24h`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      const data = await response.json();
      setHealthData(data);
    };

    fetchHealthHistory();
    const interval = setInterval(fetchHealthHistory, 60000); // 1분마다
    return () => clearInterval(interval);
  }, [robotId]);

  if (!healthData) return <div>Loading...</div>;

  const chartData = {
    labels: healthData.dataPoints.map(dp => new Date(dp.timestamp).toLocaleTimeString()),
    datasets: [
      {
        label: '배터리 (%)',
        data: healthData.dataPoints.map(dp => dp.battery),
        borderColor: 'rgb(75, 192, 192)',
        yAxisID: 'y1'
      },
      {
        label: '통신 지연 (ms)',
        data: healthData.dataPoints.map(dp => dp.commLatencyMs),
        borderColor: 'rgb(255, 99, 132)',
        yAxisID: 'y2'
      }
    ]
  };

  const options = {
    scales: {
      y1: {
        type: 'linear',
        position: 'left',
        title: { display: true, text: '배터리 (%)' }
      },
      y2: {
        type: 'linear',
        position: 'right',
        title: { display: true, text: '통신 지연 (ms)' }
      }
    }
  };

  return <Line data={chartData} options={options} />;
};
```

### 이벤트 통계 차트

```typescript
import React, { useEffect, useState } from 'react';
import { Bar } from 'react-chartjs-2';

const EventStatsChart: React.FC = () => {
  const [stats, setStats] = useState<EventStatsResponse | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      const response = await fetch('/api/events/stats/daily?days=7', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      const data = await response.json();
      setStats(data);
    };

    fetchStats();
  }, []);

  if (!stats) return <div>Loading...</div>;

  const chartData = {
    labels: stats.dataPoints.map(dp => dp.label),
    datasets: [
      {
        label: 'CRITICAL',
        data: stats.dataPoints.map(dp => dp.criticalCount),
        backgroundColor: 'rgba(255, 99, 132, 0.5)'
      },
      {
        label: 'WARNING',
        data: stats.dataPoints.map(dp => dp.warningCount),
        backgroundColor: 'rgba(255, 206, 86, 0.5)'
      }
    ]
  };

  return <Bar data={chartData} />;
};
```

### 순찰 스케줄 관리

```typescript
import React, { useEffect, useState } from 'react';

const PatrolScheduleManager: React.FC = () => {
  const [schedules, setSchedules] = useState<PatrolSchedule[]>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);

  useEffect(() => {
    fetchSchedules();
  }, []);

  const fetchSchedules = async () => {
    const response = await fetch('/api/patrol-schedules', {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });
    const data = await response.json();
    setSchedules(data);
  };

  const createSchedule = async (schedule: PatrolScheduleRequest) => {
    await fetch('/api/patrol-schedules', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(schedule)
    });
    fetchSchedules();
    setShowCreateForm(false);
  };

  const deleteSchedule = async (scheduleId: number) => {
    await fetch(`/api/patrol-schedules/${scheduleId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });
    fetchSchedules();
  };

  return (
    <div>
      <button onClick={() => setShowCreateForm(true)}>새 스케줄 추가</button>

      {showCreateForm && (
        <ScheduleForm onSubmit={createSchedule} onCancel={() => setShowCreateForm(false)} />
      )}

      <table>
        <thead>
          <tr>
            <th>이름</th>
            <th>로봇</th>
            <th>Cron 표현식</th>
            <th>활성화</th>
            <th>마지막 실행</th>
            <th>작업</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map(schedule => (
            <tr key={schedule.scheduleId}>
              <td>{schedule.name}</td>
              <td>{schedule.robotId}</td>
              <td>{schedule.cronExpression}</td>
              <td>{schedule.enabled ? '✓' : '✗'}</td>
              <td>{schedule.lastExecuted ? new Date(schedule.lastExecuted).toLocaleString() : '-'}</td>
              <td>
                <button onClick={() => deleteSchedule(schedule.scheduleId)}>삭제</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
```

---

## 📊 구현 우선순위

1. **높음** (즉시 구현 권장):
   - 대시보드 통계 API
   - 이벤트 필터링 API
   - 로봇 건강 이력 차트

2. **중간** (1-2주 내):
   - Mattermost 알림 설정
   - 이벤트 통계 차트

3. **낮음** (필요 시):
   - 자동 순찰 스케줄러

---

## 🔗 관련 문서

- Swagger UI: `/swagger-ui.html`
- Jira Epic: S15P11E101-3 (관제센터)
- 관련 티켓:
  - S15P11E101-579: Mattermost 알림 설정
  - S15P11E101-581: 자동 순찰 스케줄러
  - S15P11E101-583: 로봇 건강 이력
  - S15P11E101-585: 이벤트 통계 차트

---

## ❓ 문의사항

백엔드 API 관련 문의는 Jira 티켓에 코멘트 남겨주세요.
