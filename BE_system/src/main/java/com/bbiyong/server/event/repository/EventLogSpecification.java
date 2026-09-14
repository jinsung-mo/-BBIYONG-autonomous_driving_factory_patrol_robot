package com.bbiyong.server.event.repository;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.EventFilterRequest;
import jakarta.persistence.criteria.Predicate;
import org.springframework.data.jpa.domain.Specification;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

/**
 * EventLog 동적 쿼리 생성 (JPA Criteria API)
 */
public class EventLogSpecification {

    /**
     * 필터 조건에 따라 동적으로 Specification 생성
     */
    public static Specification<EventLog> withFilters(EventFilterRequest filter) {
        return (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();

            // 타입 필터
            if (filter.getType() != null && !filter.getType().isBlank()) {
                predicates.add(cb.equal(root.get("type"), filter.getType().trim().toUpperCase()));
            }

            // 심각도 필터
            if (filter.getLevel() != null && !filter.getLevel().isBlank()) {
                predicates.add(cb.equal(root.get("level"), filter.getLevel().trim().toUpperCase()));
            }

            // 상태 필터
            if (filter.getStatus() != null && !filter.getStatus().isBlank()) {
                predicates.add(cb.equal(root.get("status"), filter.getStatus().trim().toUpperCase()));
            }

            // 로봇 ID 필터
            if (filter.getRobotId() != null && !filter.getRobotId().isBlank()) {
                predicates.add(cb.equal(root.get("robotId"), filter.getRobotId().trim()));
            }

            // 설비 ID 필터
            if (filter.getEquipmentId() != null && !filter.getEquipmentId().isBlank()) {
                predicates.add(cb.equal(root.get("equipmentId"), filter.getEquipmentId().trim()));
            }

            // 시작 날짜 필터 (해당 날짜 00:00:00 이후)
            if (filter.getStartDate() != null) {
                var startInstant = filter.getStartDate()
                        .atStartOfDay(ZoneId.systemDefault())
                        .toInstant();
                predicates.add(cb.greaterThanOrEqualTo(root.get("timestamp"), startInstant));
            }

            // 종료 날짜 필터 (해당 날짜 23:59:59 이전)
            if (filter.getEndDate() != null) {
                var endInstant = filter.getEndDate()
                        .plusDays(1)
                        .atStartOfDay(ZoneId.systemDefault())
                        .toInstant();
                predicates.add(cb.lessThan(root.get("timestamp"), endInstant));
            }

            return cb.and(predicates.toArray(new Predicate[0]));
        };
    }
}
