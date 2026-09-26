-- 측정 대상: 관제 서버가 실제로 보내는 event_logs 조회 3종
-- Q1 통계: 최근 24시간 경보 (EventLogRepository.findByTimestampAfter)
EXPLAIN ANALYZE SELECT * FROM event_logs WHERE timestamp > NOW(6) - INTERVAL 24 HOUR;
-- Q2 이력 목록: 기간 필터 + 최신순 첫 페이지 (EventLogSpecification + Pageable)
EXPLAIN ANALYZE SELECT * FROM event_logs WHERE timestamp >= NOW(6) - INTERVAL 7 DAY AND timestamp < NOW(6) ORDER BY timestamp DESC LIMIT 20;
-- Q3 로봇별: 특정 로봇의 최근 24시간 경보 (로봇별 통계)
EXPLAIN ANALYZE SELECT * FROM event_logs WHERE robot_id = 'orinka_03' AND timestamp > NOW(6) - INTERVAL 24 HOUR;
