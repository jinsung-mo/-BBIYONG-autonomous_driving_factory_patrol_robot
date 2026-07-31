package com.bbiyong.server.waypoint.repository;

import com.bbiyong.server.waypoint.domain.Waypoint;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface WaypointRepository extends JpaRepository<Waypoint, String> {

    List<Waypoint> findByRobotIdOrderBySeqAscCreatedAtAsc(String robotId);

    void deleteByRobotId(String robotId);
}
