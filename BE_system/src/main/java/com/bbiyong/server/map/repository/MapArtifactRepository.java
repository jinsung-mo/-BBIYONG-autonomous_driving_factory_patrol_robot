package com.bbiyong.server.map.repository;

import com.bbiyong.server.map.domain.MapArtifact;
import org.springframework.data.jpa.repository.JpaRepository;
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
}
