package com.bbiyong.server.equipment.service;

import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Slf4j
@Service
public class EquipmentService {

    private static final String DEFAULT_ROBOT_ID = "orinka_01";

    private final EquipmentRepository equipmentRepository;
    private final RobotWebSocketSessionManager sessionManager;

    public EquipmentService(EquipmentRepository equipmentRepository,
                            RobotWebSocketSessionManager sessionManager) {
        this.equipmentRepository = equipmentRepository;
        this.sessionManager = sessionManager;
    }

    @Transactional(readOnly = true)
    public List<Equipment> getAllEquipments() {
        return equipmentRepository.findAll();
    }

    /**
     * 설비 임계 온도를 수정한다. 존재하지 않는 설비면 404.
     *
     * <p>DB(표시·조회용 사본)를 갱신한 뒤, 실제 과열 판정 기준을 바꾸도록 로봇으로
     * SET_THRESHOLD 명령을 중계한다. 로봇 미연결 시에도 DB 수정은 성공 처리하고
     * 경고만 남긴다(로봇 재연결·재시딩 시 반영은 상세설계).
     */
    @Transactional
    public void updateThreshold(String equipmentId, double threshold) {
        Equipment e = equipmentRepository.findById(equipmentId)
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "설비를 찾을 수 없습니다: " + equipmentId));
        e.setThreshold(threshold);
        equipmentRepository.save(e);
        log.info("Equipment [{}] threshold updated: {}", equipmentId, threshold);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("command", "SET_THRESHOLD");
        payload.put("equipmentId", equipmentId);
        payload.put("threshold", threshold);
        boolean delivered = sessionManager.sendCommand(DEFAULT_ROBOT_ID, payload);
        if (!delivered) {
            log.warn("SET_THRESHOLD not delivered (robot [{}] offline): equipment={}, threshold={}",
                    DEFAULT_ROBOT_ID, equipmentId, threshold);
        }
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
        if (packet.getThreshold() != null) {
            e.setThreshold(packet.getThreshold());
        }
        e.setStatus(over ? "OVER" : "NORMAL");
        e.setLastInspectedAt(Instant.now());
        equipmentRepository.save(e);
        log.info("Equipment [{}] inspection applied: temp={}, status={}", equipmentId, packet.getTemperature(), e.getStatus());
    }
}
