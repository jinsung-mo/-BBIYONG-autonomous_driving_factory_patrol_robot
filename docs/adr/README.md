# 설계 결정 기록 (ADR)

관제 서버를 만들면서 되돌리기 어려웠거나 나중에 "왜 이렇게 했지?"라는 질문을 받을 만한 결정을 모았습니다.

프로젝트가 끝난 뒤(2026-09) 커밋, Jira 티켓, 코드 주석을 근거로 다시 정리한 사후 기록입니다. 당시 비교 문서가 남아 있지 않은 결정은 본문에 그렇게 적었습니다.

| 번호 | 결정 | 날짜 | 상태 |
| --- | --- | --- | --- |
| [0001](0001-robot-transport-wss-443.md) | 로봇 통신을 TCP 9000에서 Nginx 경유 WSS 443으로 | 2026-07-22 | 채택 |
| [0002](0002-sqlite-to-mysql.md) | 운영 DB를 SQLite에서 MySQL 8로 | 2026-07-28 | 채택 |
| [0003](0003-async-single-thread-alert-persistence.md) | 경보 저장을 단일 스레드 비동기로 분리 | 2026-08-05 | 채택 |
| [0004](0004-idempotent-alert-unique-constraint.md) | 경보 중복 방지를 멱등 키와 DB UNIQUE로 | 2026-08-06 | 채택 |
| [0005](0005-video-path-out-of-spring.md) | 영상을 Spring 밖(MediaMTX, WebRTC)으로 | 2026-08-13 | 채택 |
| [0006](0006-java17-spring-boot4.md) | Java 17과 Spring Boot 4.1 | 2026-07-20 | 채택 |

형식: 배경 → 고려한 선택지 → 결정 → 결과(얻은 것과 치른 대가) → 근거
