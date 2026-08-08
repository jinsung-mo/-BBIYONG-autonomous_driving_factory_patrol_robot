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
import java.util.Set;

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
     * AprilTag 점검 지점 승인(CONFIRM) 시 감시 대상 설비로 등록/갱신한다 (S15P11E101).
     *
     * <p>승인한 점검 지점이 그대로 '분전반 임계온도' 목록에 나타나 임계온도를 설정할 수 있게 한다.
     * upsert: 이미 있으면 이름/좌표만 갱신하고 임계온도·상태는 보존한다(관리자가 정한 값을 지우지 않는다).
     * 좌표(x,y)는 confirm 명령에 없을 수 있어 null 이면 건드리지 않는다(있으면 지도 표시에 쓴다).
     */
    @Transactional
    public void registerInspectionEquipment(String equipmentId, String name, Double x, Double y) {
        if (equipmentId == null || equipmentId.isBlank()) {
            return;
        }
        Equipment e = equipmentRepository.findById(equipmentId).orElseGet(() -> {
            Equipment created = new Equipment();
            created.setEquipmentId(equipmentId);
            created.setStatus("UNKNOWN");
            return created;
        });
        if (name != null && !name.isBlank()) {
            e.setName(name.trim());
        } else if (e.getName() == null) {
            e.setName(equipmentId);
        }
        if (x != null) {
            e.setX(x);
        }
        if (y != null) {
            e.setY(y);
        }
        equipmentRepository.save(e);
        log.info("Equipment [{}] registered from inspection point (name={})", equipmentId, e.getName());
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

    /**
     * 데모 설비 정리 (S15P11E101). 예전 기동 시드(panel_A/B/C)와 옛 데모 흔적('데모')이
     * 설정탭 분전반 임계온도 목록에 더미로 남아 있었다. 실제 설비는 로봇 점검(applyInspection)
     * 으로만 등록되어야 하므로, 자동 시드를 제거하고 기동 시 남은 데모 행을 지운다.
     *
     * <p>id 가 panel_A/B/C 이거나, id·이름에 '데모'가 들어간 설비를 삭제한다(멱등).
     * 배포 DB가 모두 정리된 뒤에는 이 정리 로직을 제거해도 된다.
     */
    @EventListener(ApplicationReadyEvent.class)
    @Transactional
    public void purgeDemoEquipments() {
        List<Equipment> demo = equipmentRepository.findAll().stream()
                .filter(EquipmentService::isDemo)
                .toList();
        if (demo.isEmpty()) {
            return;
        }
        equipmentRepository.deleteAll(demo);
        log.info("Purged {} demo equipment(s): {}", demo.size(),
                demo.stream().map(Equipment::getEquipmentId).toList());
    }

    private static final Set<String> DEMO_IDS = Set.of("panel_A", "panel_B", "panel_C");

    private static boolean isDemo(Equipment e) {
        String id = e.getEquipmentId() == null ? "" : e.getEquipmentId();
        String name = e.getName() == null ? "" : e.getName();
        return DEMO_IDS.contains(id) || id.contains("데모") || name.contains("데모");
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
