# FE 구현 가이드: 이벤트 해결 및 실시간 핑 제거 기능

## 개요
관제 대시보드에서 화재/과열 이벤트를 확인하고 해결 처리하는 기능 구현 가이드입니다.
이벤트를 해결하면 모든 관제 클라이언트에서 실시간으로 핑이 사라지거나 상태가 업데이트됩니다.

## 1. 문제 해결: 영상 재생 시 중복 이벤트 감지

### 1.1 현재 아키텍처
- **저장된 영상 재생**: `/api/videos/{videoId}/stream` → HTTP 스트리밍만 수행, AI 감지 없음 ✅
- **실시간 영상 스트리밍**: STOMP `/topic/video/{robotId}` → 로봇이 보내는 실시간 프레임 (AI 감지 O)

### 1.2 중복 감지가 발생하지 않는 이유
저장된 영상(`/api/videos/{id}/stream`)을 웹에서 재생할 때는:
- 서버가 파일을 HTTP로 스트리밍만 함
- 화재/과열 AI 모델을 거치지 않음
- **따라서 중복 이벤트가 발생하지 않습니다**

### 1.3 만약 문제가 발생한다면 확인할 사항
프론트엔드에서 다음을 확인하세요:

1. **STOMP 구독 중복**
   ```typescript
   // ❌ 잘못된 예: 컴포넌트 재렌더링마다 구독
   useEffect(() => {
     stompClient.subscribe('/topic/alerts', handleAlert);
   }); // 의존성 배열 없음 - 매번 구독!

   // ✅ 올바른 예: 한 번만 구독
   useEffect(() => {
     const subscription = stompClient.subscribe('/topic/alerts', handleAlert);
     return () => subscription.unsubscribe();
   }, []); // 빈 배열 - 마운트 시 한 번만
   ```

2. **실시간 알람과 과거 이벤트 혼동**
   ```typescript
   // ❌ 잘못된 예: 실시간 알람을 계속 누적
   const handleAlert = (alert) => {
     setAlerts(prev => [...prev, alert]); // 중복 제거 없음
   };

   // ✅ 올바른 예: eventId 기준 중복 제거
   const handleAlert = (alert) => {
     setAlerts(prev => {
       const exists = prev.some(a => a.eventId === alert.eventId);
       return exists ? prev : [...prev, alert];
     });
   };
   ```

## 2. 이벤트 해결 기능 구현

### 2.1 API 엔드포인트

#### 이벤트 상태 업데이트
```
PATCH /api/events/{eventId}
```

**Request Body:**
```typescript
interface EventStatusUpdateRequest {
  status: "UNRESOLVED" | "ACKNOWLEDGED" | "RESOLVED";
}
```

**Response:**
```typescript
interface EventLog {
  eventId: number;
  type: "FIRE" | "OVERHEAT" | "SYSTEM";
  level: "CRITICAL" | "WARNING" | "INFO";
  status: "UNRESOLVED" | "ACKNOWLEDGED" | "RESOLVED";
  robotId: string;
  message: string;
  timestamp: string;
  // ... 기타 필드
}
```

**Example:**
```typescript
const resolveEvent = async (eventId: number) => {
  const response = await fetch(`/api/events/${eventId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ status: 'RESOLVED' })
  });

  if (!response.ok) {
    throw new Error('이벤트 상태 업데이트 실패');
  }

  return await response.json();
};
```

### 2.2 실시간 상태 동기화 (WebSocket STOMP)

#### 이벤트 상태 변경 구독
```
STOMP SUBSCRIBE /topic/events/status
```

**메시지 포맷:**
```typescript
interface EventStatusUpdate {
  eventId: number;
  status: "UNRESOLVED" | "ACKNOWLEDGED" | "RESOLVED";
  timestamp: number; // Unix timestamp (milliseconds)
}
```

**구현 예제:**
```typescript
import { Client, StompSubscription } from '@stomp/stompjs';

// 1. STOMP 클라이언트 연결
const stompClient = new Client({
  brokerURL: 'ws://localhost:8080/ws',
  connectHeaders: {
    Authorization: `Bearer ${token}`
  },
  onConnect: () => {
    console.log('STOMP connected');

    // 실시간 알람 구독
    stompClient.subscribe('/topic/alerts', (message) => {
      const alert = JSON.parse(message.body);
      handleNewAlert(alert);
    });

    // 이벤트 상태 변경 구독 (핵심!)
    stompClient.subscribe('/topic/events/status', (message) => {
      const update: EventStatusUpdate = JSON.parse(message.body);
      handleStatusUpdate(update);
    });
  }
});

stompClient.activate();
```

### 2.3 React 컴포넌트 구현 예제

#### 이벤트 목록 + 실시간 상태 동기화
```typescript
import React, { useEffect, useState } from 'react';
import { Client } from '@stomp/stompjs';

interface Event {
  eventId: number;
  type: string;
  level: string;
  status: string;
  message: string;
  timestamp: string;
  robotId: string;
}

const EventMonitorPage: React.FC = () => {
  const [events, setEvents] = useState<Event[]>([]);
  const [stompClient, setStompClient] = useState<Client | null>(null);

  // 초기 이벤트 로드
  useEffect(() => {
    const fetchEvents = async () => {
      const response = await fetch('/api/events?status=UNRESOLVED&size=50');
      const data = await response.json();
      setEvents(data.events);
    };

    fetchEvents();
  }, []);

  // STOMP 연결 및 구독
  useEffect(() => {
    const client = new Client({
      brokerURL: `ws://${window.location.host}/ws`,
      connectHeaders: {
        Authorization: `Bearer ${localStorage.getItem('token')}`
      },
      onConnect: () => {
        console.log('STOMP connected');

        // 새 알람 구독
        client.subscribe('/topic/alerts', (message) => {
          const alert = JSON.parse(message.body);
          if (alert.eventId) {
            setEvents(prev => [alert, ...prev]);
          }
        });

        // 상태 변경 구독 (핵심!)
        client.subscribe('/topic/events/status', (message) => {
          const update = JSON.parse(message.body);

          setEvents(prev =>
            prev.map(event =>
              event.eventId === update.eventId
                ? { ...event, status: update.status }
                : event
            ).filter(event =>
              // RESOLVED 이벤트는 목록에서 제거 (선택사항)
              event.status !== 'RESOLVED'
            )
          );

          console.log(`Event ${update.eventId} status changed to ${update.status}`);
        });
      },
      onDisconnect: () => {
        console.log('STOMP disconnected');
      }
    });

    client.activate();
    setStompClient(client);

    return () => {
      client.deactivate();
    };
  }, []);

  // 이벤트 해결 처리
  const handleResolveEvent = async (eventId: number) => {
    try {
      await fetch(`/api/events/${eventId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ status: 'RESOLVED' })
      });

      // API 호출 성공 시, STOMP 메시지를 통해 자동으로 UI가 업데이트됩니다
      // (모든 클라이언트에서 동시에 업데이트됨)
    } catch (error) {
      console.error('Failed to resolve event:', error);
      alert('이벤트 해결 처리 실패');
    }
  };

  return (
    <div className="event-monitor">
      <h2>실시간 이벤트 모니터</h2>

      {events.length === 0 && (
        <div className="no-events">
          <p>현재 미해결 이벤트가 없습니다</p>
        </div>
      )}

      <div className="event-list">
        {events.map(event => (
          <EventCard
            key={event.eventId}
            event={event}
            onResolve={handleResolveEvent}
          />
        ))}
      </div>
    </div>
  );
};

interface EventCardProps {
  event: Event;
  onResolve: (eventId: number) => void;
}

const EventCard: React.FC<EventCardProps> = ({ event, onResolve }) => {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div
      className={`event-card ${event.type} ${event.status}`}
      onClick={() => setShowDetail(true)}
    >
      <div className="event-header">
        <span className={`badge ${event.type}`}>{event.type}</span>
        <span className={`level ${event.level}`}>{event.level}</span>
        <span className={`status ${event.status}`}>{event.status}</span>
      </div>

      <div className="event-body">
        <p className="message">{event.message}</p>
        <p className="robot-id">로봇: {event.robotId}</p>
        <p className="timestamp">
          {new Date(event.timestamp).toLocaleString('ko-KR')}
        </p>
      </div>

      <div className="event-actions" onClick={(e) => e.stopPropagation()}>
        {event.status === 'UNRESOLVED' && (
          <>
            <button
              className="btn-acknowledge"
              onClick={() => {
                // 확인 처리 (선택사항)
                fetch(`/api/events/${event.eventId}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status: 'ACKNOWLEDGED' })
                });
              }}
            >
              확인
            </button>
            <button
              className="btn-resolve"
              onClick={() => onResolve(event.eventId)}
            >
              해결 완료
            </button>
          </>
        )}
      </div>

      {showDetail && (
        <EventDetailModal
          eventId={event.eventId}
          onClose={() => setShowDetail(false)}
        />
      )}
    </div>
  );
};

export default EventMonitorPage;
```

### 2.4 맵 핑(Ping) 제거 구현

이벤트를 지도에 핑으로 표시하는 경우:

```typescript
interface MapPing {
  eventId: number;
  x: number;
  y: number;
  type: string;
  status: string;
}

const MapView: React.FC = () => {
  const [pings, setPings] = useState<MapPing[]>([]);

  useEffect(() => {
    // STOMP 상태 변경 구독
    stompClient.subscribe('/topic/events/status', (message) => {
      const update = JSON.parse(message.body);

      if (update.status === 'RESOLVED') {
        // RESOLVED된 이벤트의 핑 제거
        setPings(prev => prev.filter(ping => ping.eventId !== update.eventId));
      } else {
        // 상태만 업데이트 (핑은 유지)
        setPings(prev => prev.map(ping =>
          ping.eventId === update.eventId
            ? { ...ping, status: update.status }
            : ping
        ));
      }
    });
  }, []);

  return (
    <div className="map-container">
      {/* 지도 렌더링 */}
      {pings.map(ping => (
        <MapMarker
          key={ping.eventId}
          x={ping.x}
          y={ping.y}
          type={ping.type}
          status={ping.status}
          onClick={() => {
            // 핑 클릭 시 이벤트 상세 팝업
            showEventDetail(ping.eventId);
          }}
        />
      ))}
    </div>
  );
};
```

## 3. CSS 스타일 예제

```css
/* 이벤트 카드 */
.event-card {
  border: 2px solid #ddd;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: all 0.2s;
}

.event-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  transform: translateY(-2px);
}

/* 이벤트 타입별 색상 */
.event-card.FIRE {
  border-left: 4px solid #ff4444;
}

.event-card.OVERHEAT {
  border-left: 4px solid #ff9800;
}

.event-card.SYSTEM {
  border-left: 4px solid #2196f3;
}

/* 상태별 스타일 */
.event-card.RESOLVED {
  opacity: 0.6;
  background-color: #f5f5f5;
}

.event-card.ACKNOWLEDGED {
  background-color: #fff9e6;
}

/* 배지 */
.badge {
  display: inline-block;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  margin-right: 8px;
}

.badge.FIRE {
  background-color: #ff4444;
  color: white;
}

.badge.OVERHEAT {
  background-color: #ff9800;
  color: white;
}

/* 액션 버튼 */
.event-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.btn-acknowledge {
  padding: 8px 16px;
  background-color: #2196f3;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-acknowledge:hover {
  background-color: #1976d2;
}

.btn-resolve {
  padding: 8px 16px;
  background-color: #4caf50;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-resolve:hover {
  background-color: #388e3c;
}

/* 맵 핑 애니메이션 (페이드 아웃) */
.map-ping.removing {
  animation: fadeOut 0.5s ease-out forwards;
}

@keyframes fadeOut {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.8);
  }
}

/* 맵 핑 펄스 애니메이션 (미해결 이벤트) */
.map-ping.UNRESOLVED {
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(1.1);
  }
}
```

## 4. 상태 흐름도

```
┌─────────────────────────────────────────────────────────────┐
│                     이벤트 발생                              │
│  (로봇 → WebSocket → EventLogService)                       │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
         ┌─────────────────┐
         │ DB 저장          │
         │ status: UNRESOLVED│
         └────────┬─────────┘
                   │
                   ▼
         ┌─────────────────┐
         │ STOMP 브로드캐스트 │
         │ /topic/alerts   │
         └────────┬─────────┘
                   │
                   ▼
         ┌─────────────────┐
         │ 모든 FE 클라이언트 │
         │ 실시간 알람 표시  │
         └────────┬─────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
        ▼                     ▼
┌──────────────┐      ┌──────────────┐
│ 관제사 1      │      │ 관제사 2      │
│ 이벤트 확인   │      │ (동일 화면)   │
└──────┬───────┘      └───────────────┘
       │
       ▼
┌──────────────┐
│ "해결" 버튼 클릭│
└──────┬───────┘
       │
       ▼
┌──────────────────┐
│ PATCH /api/events/{id} │
│ { status: "RESOLVED" } │
└──────┬─────────────────┘
       │
       ▼
┌──────────────┐
│ DB 업데이트   │
│ status: RESOLVED │
└──────┬───────┘
       │
       ▼
┌─────────────────────┐
│ STOMP 브로드캐스트    │
│ /topic/events/status │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│ 모든 FE 클라이언트     │
│ 핑 제거/상태 업데이트  │
└─────────────────────┘
```

## 5. 주요 구현 포인트

### 5.1 중복 방지
- STOMP 구독은 컴포넌트 마운트 시 한 번만 (`useEffect` 의존성 배열 `[]`)
- 언마운트 시 `subscription.unsubscribe()` 호출 필수
- 알람 핸들링 시 `eventId` 기준 중복 제거

### 5.2 실시간 동기화
- `/topic/events/status` 구독 시 **모든 관제 클라이언트**가 즉시 업데이트
- 한 관제사가 이벤트를 해결하면 다른 모든 화면에서도 핑이 사라짐
- 낙관적 UI 업데이트 불필요 (STOMP 메시지로 충분)

### 5.3 상태 전이
```
UNRESOLVED (미해결)
    ↓
ACKNOWLEDGED (확인됨, 조치 중)
    ↓
RESOLVED (해결 완료) → 핑 제거
```

### 5.4 에러 처리
```typescript
const handleResolveEvent = async (eventId: number) => {
  try {
    const response = await fetch(`/api/events/${eventId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ status: 'RESOLVED' })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || '이벤트 해결 처리 실패');
    }

    // 성공 시 토스트 알림 (선택사항)
    showToast('이벤트가 해결 처리되었습니다', 'success');

  } catch (error) {
    console.error('Failed to resolve event:', error);
    showToast('이벤트 해결 처리 중 오류가 발생했습니다', 'error');
  }
};
```

## 6. 테스트 시나리오

### 6.1 기본 동작 테스트
1. 이벤트 발생 시 실시간 알람 수신 확인
2. "해결" 버튼 클릭 → API 호출 성공 확인
3. STOMP 메시지 수신 → 핑이 지도에서 사라지는지 확인
4. 다른 브라우저 탭에서도 동시에 핑이 사라지는지 확인

### 6.2 동시성 테스트
1. 여러 관제사가 동시에 접속
2. 한 관제사가 이벤트 해결
3. 모든 관제사 화면에서 동시에 핑이 사라지는지 확인

### 6.3 재접속 테스트
1. 이벤트 발생 후 브라우저 새로고침
2. 페이지 로드 시 미해결 이벤트만 표시되는지 확인
3. STOMP 재연결 후 실시간 업데이트 정상 동작 확인

## 7. 문제 해결 (Troubleshooting)

### Q1. 영상 재생 시 화재 알람이 계속 울려요
**A:** 이는 프론트엔드 STOMP 구독 이슈입니다. 백엔드는 저장된 영상 스트리밍 시 AI 감지를 하지 않습니다.
- STOMP 구독이 중복되었는지 확인
- 컴포넌트 재렌더링 시 구독이 계속 추가되는지 확인
- 브라우저 DevTools Network 탭에서 WebSocket 연결 수 확인

### Q2. 해결 버튼을 눌렀는데 다른 화면에서 핑이 안 사라져요
**A:** STOMP 구독이 제대로 설정되지 않았을 수 있습니다.
```typescript
// 확인 사항:
// 1. /topic/events/status 구독 여부
stompClient.subscribe('/topic/events/status', handleStatusUpdate);

// 2. handleStatusUpdate 함수 로직
const handleStatusUpdate = (message) => {
  const update = JSON.parse(message.body);
  console.log('Status update received:', update); // 디버깅

  // eventId 기준으로 상태 업데이트 또는 제거
  setPings(prev => prev.filter(p => p.eventId !== update.eventId));
};
```

### Q3. 페이지 새로고침 후 이미 해결된 이벤트가 다시 나타나요
**A:** 이벤트 목록 API 호출 시 필터링하세요.
```typescript
// ✅ 미해결 이벤트만 가져오기
const response = await fetch('/api/events?status=UNRESOLVED&size=50');
```

## 8. API 응답 예제

### 8.1 이벤트 상태 업데이트 응답
```json
{
  "eventId": 123,
  "type": "FIRE",
  "level": "CRITICAL",
  "status": "RESOLVED",
  "robotId": "ROBOT-001",
  "message": "화재 발생",
  "timestamp": "2026-08-13T10:30:00Z",
  "x": 10.5,
  "y": 20.3,
  "confidence": 0.95
}
```

### 8.2 STOMP 상태 변경 메시지
```json
{
  "eventId": 123,
  "status": "RESOLVED",
  "timestamp": 1691924400000
}
```

## 9. 배포 전 체크리스트

- [ ] STOMP 연결 설정이 production URL로 되어 있는지 확인
- [ ] 인증 토큰이 WebSocket 헤더에 포함되는지 확인
- [ ] 언마운트 시 STOMP 구독 해제 확인 (메모리 누수 방지)
- [ ] 이벤트 해결 API 권한 설정 확인
- [ ] 여러 브라우저/디바이스에서 동시 테스트
- [ ] 네트워크 단절 후 재연결 시나리오 테스트

## 10. 문의 및 지원

구현 중 문제가 발생하거나 추가 기능이 필요한 경우:
- Swagger UI: http://localhost:8080/swagger-ui.html
- API Docs: http://localhost:8080/v3/api-docs
- STOMP Endpoint: ws://localhost:8080/ws
- 백엔드 담당자에게 문의
