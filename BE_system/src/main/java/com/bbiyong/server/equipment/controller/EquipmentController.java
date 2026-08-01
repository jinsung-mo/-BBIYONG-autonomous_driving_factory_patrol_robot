package com.bbiyong.server.equipment.controller;

import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.dto.StatusResponse;
import com.bbiyong.server.equipment.dto.ThresholdUpdateRequest;
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

    @PutMapping("/{id}")
    public ResponseEntity<StatusResponse> updateThreshold(
            @PathVariable("id") String id,
            @Valid @RequestBody ThresholdUpdateRequest request) {
        equipmentService.updateThreshold(id, request.threshold());
        return ResponseEntity.ok(StatusResponse.success());
    }
}
