package com.bbiyong.server.scheduler.repository;

import com.bbiyong.server.scheduler.domain.PatrolSchedule;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public interface PatrolScheduleRepository extends JpaRepository<PatrolSchedule, Long> {

    List<PatrolSchedule> findByEnabledTrue();

    List<PatrolSchedule> findByRobotId(String robotId);
}
