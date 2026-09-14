package com.bbiyong.server.zone.repository;

import com.bbiyong.server.zone.domain.Zone;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface ZoneRepository extends JpaRepository<Zone, String> {

    List<Zone> findAllByOrderByCreatedAtAsc();
}
