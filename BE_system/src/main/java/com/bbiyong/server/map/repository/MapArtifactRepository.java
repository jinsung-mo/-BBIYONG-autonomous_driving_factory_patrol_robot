package com.bbiyong.server.map.repository;

import com.bbiyong.server.map.domain.MapArtifact;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface MapArtifactRepository extends JpaRepository<MapArtifact, String> {

    List<MapArtifact> findAllByOrderByCreatedAtDesc();

    Optional<MapArtifact> findFirstByRobotIdOrderByCreatedAtDesc(String robotId);

    Optional<MapArtifact> findFirstByOrderByCreatedAtDesc();

    Optional<MapArtifact> findFirstByActiveTrueOrderByCreatedAtDesc();

    List<MapArtifact> findByActiveTrue();

    /** 로봇별 최신 RAW(원본) 맵. kind 가 null 이면 RAW 로 취급, FLOORPLAN 은 제외. */
    @Query("select m from MapArtifact m where m.robotId = :robotId "
            + "and (m.kind is null or m.kind <> 'FLOORPLAN') order by m.createdAt desc")
    List<MapArtifact> findLatestRaw(@Param("robotId") String robotId, Pageable pageable);
}
