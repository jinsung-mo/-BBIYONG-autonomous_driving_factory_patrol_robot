package com.bbiyong.server.video.repository;

import com.bbiyong.server.video.domain.VideoClip;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;

@Repository
public interface VideoClipRepository extends JpaRepository<VideoClip, String> {

    @Query("""
            SELECT v FROM VideoClip v
            WHERE (:robotId IS NULL OR v.robotId = :robotId)
              AND (:clipType IS NULL OR v.clipType = :clipType)
              AND (:from IS NULL OR v.startedAt >= :from)
              AND (:to IS NULL OR v.startedAt <= :to)
            """)
    Page<VideoClip> search(@Param("robotId") String robotId,
                           @Param("clipType") String clipType,
                           @Param("from") Instant from,
                           @Param("to") Instant to,
                           Pageable pageable);

    List<VideoClip> findByEventIdOrderByStartedAtDesc(Long eventId);

    /**
     * 특정 이벤트에 연관된 영상이 존재하는지 확인
     */
    boolean existsByEventId(Long eventId);
}
