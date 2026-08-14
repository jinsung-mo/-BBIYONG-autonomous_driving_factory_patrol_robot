package com.bbiyong.server.equipment.controller;

import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.dto.EquipmentThresholdRequest;
import com.bbiyong.server.equipment.service.EquipmentService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/equipments")
public class EquipmentController {

    private final EquipmentService equipmentService;

    public EquipmentController(EquipmentService equipmentService) {
        this.equipmentService = equipmentService;
    }

    @GetMapping
    public ResponseEntity<List<Equipment>> getEquipments() {
        return ResponseEntity.ok(equipmentService.getAllEquipments());
    }

    /**
     * 분전반 과열 임계온도 설정 (S15P11E101-836). 서버가 값을 저장하고 '최근온도 &gt; 임계온도' 면
     * 과열(OVER)로 판정한다. 로봇 프로토콜에 SET_THRESHOLD 가 없어 로봇으로 하달하지는 않는다.
     * 없는 설비면 404.
     */
    @PutMapping("/{id}")
    public ResponseEntity<Map<String, String>> updateThreshold(
            @PathVariable String id,
            @Valid @RequestBody EquipmentThresholdRequest request) {
        equipmentService.updateThreshold(id, request.threshold());
        return ResponseEntity.ok(Map.of("status", "success"));
    }
}
