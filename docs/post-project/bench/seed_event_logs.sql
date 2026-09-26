-- 벤치마크용 합성 데이터: event_logs 200,000건
-- 로봇 5대, 최근 30일에 고르게 분포. 실제 운영 데이터가 아니라 인덱스 효과를 재기 위한 데이터다.
SET SESSION cte_max_recursion_depth = 1000000;
INSERT INTO event_logs (type, level, robot_id, message_id, message, timestamp, status, simulated)
WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200000)
SELECT
  ELT(1 + (n % 3), 'FIRE', 'OVERHEAT', 'SYSTEM'),
  ELT(1 + (n % 3), 'CRITICAL', 'WARNING', 'INFO'),
  CONCAT('orinka_0', 1 + (n % 5)),
  CONCAT('bench-', n),
  '벤치마크 경보',
  NOW(6) - INTERVAL (n * 13) SECOND,
  ELT(1 + (n % 3), 'UNRESOLVED', 'ACKNOWLEDGED', 'RESOLVED'),
  0
FROM seq;
ANALYZE TABLE event_logs;
