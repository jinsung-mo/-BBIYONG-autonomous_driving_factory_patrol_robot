-- V2: 프로젝트 종료 후 개인 저장소에서 정리한 스키마 개선 (2026-09)
--
-- 1) event_logs 조회 인덱스
--    통계(최근 N시간), 이력 목록(기간 필터 + 최신순), 로봇별 통계가 모두 timestamp 범위로 조회하는데
--    인덱스가 없어 매번 전체 스캔을 했다. 측정 결과는 docs/post-project/README.md 참고.
--
-- 2) 외래키
--    팀 프로젝트 기간의 스키마에는 외래키가 하나도 없었다(초기 SQLite 방언이 FK를 무시했고, 이후에도
--    ddl-auto=update로 관리). 참조 무결성을 DB가 지키도록 아래 관계에 외래키를 건다.
--    일부러 걸지 않은 관계:
--    - event_logs.equipment_id -> equipments, event_logs.map_id -> map_artifacts
--      로봇이 등록되지 않은 설비나 지도 기준으로 경보를 보내도 경보는 반드시 저장돼야 한다.
--      화재 경보를 참조 오류로 잃는 것보다 참조가 어긋난 경보가 남는 편이 낫다.
--
-- 3) 기존 데이터 정리
--    외래키를 걸기 전에 이미 어긋난 참조를 정리해야 ALTER가 실패하지 않는다.

-- 1) 인덱스 -------------------------------------------------------------------
CREATE INDEX idx_event_logs_timestamp ON event_logs (timestamp);
CREATE INDEX idx_event_logs_robot_timestamp ON event_logs (robot_id, timestamp);

-- 3) 어긋난 참조 정리 ------------------------------------------------------------
UPDATE video_clips v
    LEFT JOIN event_logs e ON e.event_id = v.event_id
SET v.event_id = NULL
WHERE v.event_id IS NOT NULL AND e.event_id IS NULL;

DELETE d FROM notification_deliveries d
    LEFT JOIN event_logs e ON e.event_id = d.event_id
WHERE e.event_id IS NULL;

DELETE d FROM notification_deliveries d
    LEFT JOIN users u ON u.email = d.recipient_user_id
WHERE u.email IS NULL;

DELETE s FROM notification_settings s
    LEFT JOIN users u ON u.email = s.user_id
WHERE u.email IS NULL;

-- 같은 사용자의 설정 행이 둘 이상이면 가장 먼저 만든 행만 남긴다(아래 UNIQUE 전제).
DELETE s1 FROM notification_settings s1
    JOIN notification_settings s2 ON s1.user_id = s2.user_id AND s1.id > s2.id;

UPDATE map_artifacts m
    LEFT JOIN map_artifacts src ON src.id = m.source_map_id
SET m.source_map_id = NULL
WHERE m.source_map_id IS NOT NULL AND src.id IS NULL;

-- 2) 외래키 -------------------------------------------------------------------
-- 이벤트를 지워도 영상 파일 기록은 남긴다(연결만 끊음).
ALTER TABLE video_clips
    ADD CONSTRAINT fk_video_clips_event
        FOREIGN KEY (event_id) REFERENCES event_logs (event_id) ON DELETE SET NULL;

-- 이벤트가 지워지면 그 이벤트의 알림 발송 기록도 의미가 없다.
ALTER TABLE notification_deliveries
    ADD CONSTRAINT fk_notification_deliveries_event
        FOREIGN KEY (event_id) REFERENCES event_logs (event_id) ON DELETE CASCADE;

-- 알림 테이블의 사용자 컬럼에는 users.id가 아니라 로그인 이메일(JWT subject)이 들어간다.
-- users.email은 UNIQUE이고 가입 때만 정해지므로 이메일을 참조 대상으로 삼는다.
ALTER TABLE notification_deliveries
    ADD CONSTRAINT fk_notification_deliveries_user
        FOREIGN KEY (recipient_user_id) REFERENCES users (email) ON DELETE CASCADE;

ALTER TABLE notification_settings
    ADD CONSTRAINT fk_notification_settings_user
        FOREIGN KEY (user_id) REFERENCES users (email) ON DELETE CASCADE;

-- 설정 한 사람당 한 행이라는 전제를 DB로도 보장한다(findByUserId가 Optional 하나를 기대).
ALTER TABLE notification_settings
    ADD CONSTRAINT uk_notification_settings_user UNIQUE (user_id);

-- 원본 지도가 지워져도 파생 도면은 남긴다.
ALTER TABLE map_artifacts
    ADD CONSTRAINT fk_map_artifacts_source
        FOREIGN KEY (source_map_id) REFERENCES map_artifacts (id) ON DELETE SET NULL;
