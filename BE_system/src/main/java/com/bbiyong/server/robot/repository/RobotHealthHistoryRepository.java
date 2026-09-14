package com.bbiyong.server.robot.repository;

import com.bbiyong.server.robot.domain.RobotHealthHistory;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;

@Repository
public interface RobotHealthHistoryRepository extends JpaRepository<RobotHealthHistory, Long> {

    /**
     * 특정 로봇의 특정 기간 건강 이력 조회 (시간 순)
     */
    List<RobotHealthHistory> findByRobotIdAndTimestampBetweenOrderByTimestampAsc(
            String robotId,
            Instant startTime,
            Instant endTime
    );

    /**
     * 특정 로봇의 최근 이력 조회 (제한된 개수)
     */
    @Query("SELECT h FROM RobotHealthHistory h WHERE h.robotId = :robotId ORDER BY h.timestamp DESC LIMIT :limit")
    List<RobotHealthHistory> findRecentByRobotId(String robotId, int limit);

    /**
     * 오래된 이력 삭제 (데이터 정리용)
     */
    void deleteByTimestampBefore(Instant cutoffTime);
}
