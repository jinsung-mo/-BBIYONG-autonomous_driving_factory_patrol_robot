# 0004. 경보 중복 방지를 멱등 키와 DB UNIQUE로

- 날짜: 2026-08-06
- 상태: 채택

## 배경

로봇은 무선으로 붙어 있어서 연결이 끊겼다 다시 붙으면 같은 경보를 다시 보냅니다. 같은 화재가 두 건으로 저장되면 관제사는 두 번 출동 판단을 해야 하고, 알림도 두 번 나갑니다.

그전까지는 서버 메모리의 맵으로 "같은 로봇, 같은 종류 경보를 10분 동안 억제"하고 있었습니다. 이 방식은 서버를 다시 켜면 기록이 사라지고, 서버가 두 대가 되면 서로의 기록을 모릅니다.

## 고려한 선택지

1. **메모리 맵만 사용**: 가장 간단하지만 재시작과 다중 인스턴스에 약합니다.
2. **분산 락(Redis 등)**: 인스턴스 사이에서도 막을 수 있지만 락 만료와 장애 처리가 복잡하고 Redis가 새로 필요합니다.
3. **멱등 키 + DB UNIQUE 제약**: 로봇이 경보마다 바뀌지 않는 `messageId`를 붙이고, DB가 최종 판단합니다.

## 결정

3번을 택했고, 메모리 맵은 `messageId`가 없는 구버전 로봇용으로 남겼습니다.

1. 저장 전에 `findByMessageId`로 조회해서 이미 있으면 무시합니다.
2. 조회와 저장 사이에 같은 요청이 동시에 들어오면 `event_logs.message_id` UNIQUE 제약이 막습니다. 이때 나는 `DataIntegrityViolationException`은 "이미 처리된 요청"으로 보고 흡수합니다.
3. 알림도 같은 원리입니다. `notification_deliveries (event_id, recipient_user_id)` 복합 UNIQUE로 한 사람에게 같은 경보 알림이 두 번 쌓이지 않습니다.

## 결과

- 얻은 것: 재시작과 다중 인스턴스에서도 경보가 한 건만 남음. 조회만으로는 막을 수 없는 동시 요청까지 DB가 막음.
- 치른 대가: UNIQUE 위반을 정상 흐름으로 다뤄야 해서 예외 처리가 조금 늘었습니다.
- 검증: 같은 `messageId` 경보를 동시에 보내도 한 건만 저장되는지 확인하는 테스트를 프로젝트 이후 추가했습니다([개선 기록](../post-project/README.md)).
- 전제 조건: DB가 UNIQUE를 실제로 지켜야 합니다. SQLite 방언에서는 그렇지 않았고, 이것이 [0002](0002-sqlite-to-mysql.md)의 이유 중 하나입니다.

## 근거

- [`EventLogService.java`](../../BE_system/src/main/java/com/bbiyong/server/event/service/EventLogService.java)
- [`EventLog.java`](../../BE_system/src/main/java/com/bbiyong/server/event/domain/EventLog.java) `messageId` 컬럼
