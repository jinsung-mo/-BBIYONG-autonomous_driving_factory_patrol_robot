package com.bbiyong.server.equipment.service;

import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotInspectionEvent;
import com.bbiyong.server.wss.event.RobotOverheatEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;

@Slf4j
@Service
public class EquipmentService {

    private final EquipmentRepository equipmentRepository;

    public EquipmentService(EquipmentRepository equipmentRepository) {
        this.equipmentRepository = equipmentRepository;
    }

    @Transactional(readOnly = true)
    public List<Equipment> getAllEquipments() {
        return equipmentRepository.findAll();
    }

    /**
     * 분전반 과열 임계온도 설정 (S15P11E101-836).
     *
     * 서버가 임계온도를 소유하고, 저장 즉시 최근 온도로 과열 여부를 다시 판정한다.
     * 로봇 프로토콜에 SET_THRESHOLD 가 없어 로봇으로 하달하지 않는다 — 이 값은 서버 판정용이다.
     */
    @Transactional
    public void updateThreshold(String id, double threshold) {
        Equipment e = equipmentRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "설비를 찾을 수 없습니다."));
        e.setThreshold(threshold);
        e.setStatus(evaluateStatus(e.getLastTemperature(), threshold, e.getStatus()));
        equipmentRepository.save(e);
        log.info("Equipment [{}] threshold set to {} -> status={}", id, threshold, e.getStatus());
    }

    /**
     * 서버 과열 판정 (S15P11E101-836). 최근온도와 임계온도가 모두 있으면 초과 여부로 OVER/NORMAL 을
     * 매기고, 둘 중 하나라도 없으면 판정할 수 없어 fallback(기존 상태 또는 로봇 판정)을 그대로 둔다.
     */
    private String evaluateStatus(Double temperature, Double threshold, String fallback) {
        if (temperature == null || threshold == null) {
            return fallback != null ? fallback : "UNKNOWN";
        }
        return temperature > threshold ? "OVER" : "NORMAL";
    }

    /** 애플리케이션 기동 시 감시 대상 분전반 초기 시드 (비어있을 때만). */
    @EventListener(ApplicationReadyEvent.class)
    @Transactional
    public void seedDefaults() {
        if (equipmentRepository.count() > 0) {
            return;
        }
        save("panel_A", "A구역 분전반", 8.5, 3.1, 55.0);
        save("panel_B", "B구역 분전반", 12.8, 14.2, 55.0);
        save("panel_C", "C구역 분전반", 3.2, 9.7, 55.0);
        log.info("Seeded default equipments: panel_A/B/C");
    }

    private void save(String id, String name, double x, double y, double threshold) {
        Equipment e = new Equipment();
        e.setEquipmentId(id);
        e.setName(name);
        e.setX(x);
        e.setY(y);
        e.setThreshold(threshold);
        e.setStatus("UNKNOWN");
        equipmentRepository.save(e);
    }

    @EventListener
    @Transactional
    public void onOverheat(RobotOverheatEvent event) {
        applyInspection(event.getPacket(), true);
    }

    @EventListener
    @Transactional
    public void onInspection(RobotInspectionEvent event) {
        applyInspection(event.getPacket(), false);
    }

    /** 로봇 점검 결과를 설비 최근 상태에 반영 (미등록 설비면 upsert). */
    private void applyInspection(RobotPacket packet, boolean over) {
        String equipmentId = packet.getEquipmentId();
        if (equipmentId == null || equipmentId.isBlank()) {
            log.warn("Inspection packet without equipment_id (over={})", over);
            return;
        }
        Equipment e = equipmentRepository.findById(equipmentId).orElseGet(() -> {
            Equipment created = new Equipment();
            created.setEquipmentId(equipmentId);
            created.setName(equipmentId);
            return created;
        });
        e.setLastTemperature(packet.getTemperature());
        // 임계온도는 서버가 소유한다(S15P11E101-836) — 관리자가 정한 값을 로봇 보고로 덮지 않는다.
        // 서버에 값이 아직 없을 때만 로봇이 보낸 값으로 초기 시드한다.
        if (e.getThreshold() == null && packet.getThreshold() != null) {
            e.setThreshold(packet.getThreshold());
        }
        // 서버 저장 임계온도로 과열을 판정한다. 기준/온도가 없으면 로봇 판정(over)을 따른다.
        e.setStatus(evaluateStatus(packet.getTemperature(), e.getThreshold(), over ? "OVER" : "NORMAL"));
        e.setLastInspectedAt(Instant.now());
        equipmentRepository.save(e);
        log.info("Equipment [{}] inspection applied: temp={}, status={}", equipmentId, packet.getTemperature(), e.getStatus());
    }
}
