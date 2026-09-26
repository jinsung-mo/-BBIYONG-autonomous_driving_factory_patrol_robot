# 0002. 운영 DB를 SQLite에서 MySQL 8로

- 날짜: 2026-07-28 (결정 7/23, 전환 7/24~7/28)
- 상태: 채택

## 배경

처음 서버는 라즈베리파이 5에 올릴 계획이었고, 저장할 데이터는 경보 이력 정도였습니다. 로봇의 실시간 상태는 메모리에 두기로 했습니다. 그래서 설치가 필요 없는 SQLite로 시작했습니다.

개발이 진행되자 전제가 바뀌었습니다.

- 서버가 EC2로 옮겨 갔습니다(메모리 15GB 중 13GB 여유, 4 vCPU).
- 영상 클립, 지도, 순찰 경로, 알림 발송 이력, 로봇 상태 이력까지 엔티티가 11개로 늘었습니다.
- SQLite는 쓰기 잠금이 DB 파일 전체에 걸려서, 처음부터 커넥션 풀을 1로 묶어 두었습니다. 잠금 오류는 없었지만 모든 조회와 쓰기가 커넥션 하나를 기다렸고, 경보 저장이 WebSocket 수신 스레드를 막을 수 있는 구조였습니다.
- SQLite용 Hibernate 방언이 FK, UNIQUE, Index를 오류 없이 무시했습니다. 경보 중복을 막을 DB 차원의 장치가 없었습니다.
- 같은 방언에서 자동 증가 ID가 깨져 엔티티 4개를 UUID 기본키로 우회해야 했습니다.

## 고려한 선택지

1. **SQLite 유지 + WAL 모드·busy_timeout**: 읽기와 쓰기는 공존할 수 있지만 쓰는 쪽은 여전히 하나입니다. 제약 조건 무시 문제도 그대로입니다.
2. **PostgreSQL**: 기능은 충분하지만 팀이 더 익숙한 쪽은 MySQL이었습니다.
3. **MySQL 8 (InnoDB)**: 행 단위 잠금과 MVCC, 제약 조건이 실제로 동작합니다.

## 결정

운영은 MySQL 8, 로컬 개발과 빠른 테스트는 SQLite를 유지합니다. 둘은 환경변수로 전환합니다.

- 커넥션 풀: `maximum-pool-size=${DB_POOL_SIZE:1}` (SQLite 1, 운영 MySQL 10)
- compose: MySQL healthcheck와 `depends_on: service_healthy`로 DB가 준비되기 전에는 앱이 뜨지 않음
- CI 테스트는 운영과 같은 MySQL에서 실행

## 결과

- 얻은 것: 동시 커넥션 상한 1 → 10(설정값). UNIQUE 제약이 실제로 동작해 멱등 저장([0004](0004-idempotent-alert-unique-constraint.md))의 전제가 됨. JPA 덕분에 서비스 코드 수정 없이 설정만으로 전환.
- 치른 대가: DB 컨테이너 운영과 비밀번호 관리가 필요해짐.
- 남은 부채: SQLite 시절의 UUID 문자열 기본키, 외래키 없는 스키마, `ddl-auto=update` 방식의 스키마 관리. 프로젝트 이후 [개선 기록](../post-project/README.md)에서 일부를 정리했습니다.

## 근거

- [`application.properties`](../../BE_system/src/main/resources/application.properties) 커넥션 풀 주석
- [`compose.yaml`](../../BE_system/compose.yaml)
- 엔티티 주석: `VideoClip`, `MapArtifact`, `Waypoint`, `Zone`
