package com.bbiyong.server.event.repository;

import com.bbiyong.server.event.domain.EventLog;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public interface EventLogRepository extends JpaRepository<EventLog, Long>, JpaSpecificationExecutor<EventLog> {

    Page<EventLog> findByType(String type, Pageable pageable);

    Optional<EventLog> findByMessageId(String messageId);

    /**
     * 특정 시각 이후의 모든 이벤트 조회 (대시보드 통계용)
     */
    List<EventLog> findByTimestampAfter(Instant timestamp);

    /**
     * 최근 이벤트 조회 (시간 역순)
     */
    @Query("SELECT e FROM EventLog e ORDER BY e.timestamp DESC")
    List<EventLog> findLatestEvents(Pageable pageable);
}
