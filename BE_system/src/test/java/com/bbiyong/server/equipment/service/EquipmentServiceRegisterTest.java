package com.bbiyong.server.equipment.service;

import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 점검 지점 승인 → 설비 등록(registerInspectionEquipment) 단위 테스트. (S15P11E101)
 * Spring/DB 없이 리포지토리를 목으로 검증한다.
 */
class EquipmentServiceRegisterTest {

    @Test
    void createsEquipmentWhenAbsent() {
        EquipmentRepository repo = mock(EquipmentRepository.class);
        when(repo.findById("tag_7")).thenReturn(Optional.empty());
        EquipmentService svc = new EquipmentService(repo);

        svc.registerInspectionEquipment("tag_7", "3층 분전반", 12.5, 4.2);

        ArgumentCaptor<Equipment> saved = ArgumentCaptor.forClass(Equipment.class);
        verify(repo).save(saved.capture());
        Equipment e = saved.getValue();
        assertThat(e.getEquipmentId()).isEqualTo("tag_7");
        assertThat(e.getName()).isEqualTo("3층 분전반");
        assertThat(e.getX()).isEqualTo(12.5);
        assertThat(e.getY()).isEqualTo(4.2);
        assertThat(e.getStatus()).isEqualTo("UNKNOWN");
    }

    @Test
    void preservesThresholdAndStatusOnUpdate() {
        Equipment existing = new Equipment();
        existing.setEquipmentId("tag_7");
        existing.setName("옛 이름");
        existing.setThreshold(55.0);
        existing.setStatus("OVER");
        existing.setX(1.0);
        existing.setY(2.0);

        EquipmentRepository repo = mock(EquipmentRepository.class);
        when(repo.findById("tag_7")).thenReturn(Optional.of(existing));
        EquipmentService svc = new EquipmentService(repo);

        // 이름만 갱신, 좌표는 null 로 유지 요청
        svc.registerInspectionEquipment("tag_7", "새 이름", null, null);

        ArgumentCaptor<Equipment> saved = ArgumentCaptor.forClass(Equipment.class);
        verify(repo).save(saved.capture());
        Equipment e = saved.getValue();
        assertThat(e.getName()).isEqualTo("새 이름");     // 이름 갱신
        assertThat(e.getThreshold()).isEqualTo(55.0);      // 관리자 임계온도 보존
        assertThat(e.getStatus()).isEqualTo("OVER");       // 상태 보존
        assertThat(e.getX()).isEqualTo(1.0);               // 좌표 보존(null 은 미변경)
        assertThat(e.getY()).isEqualTo(2.0);
    }

    @Test
    void ignoresBlankId() {
        EquipmentRepository repo = mock(EquipmentRepository.class);
        EquipmentService svc = new EquipmentService(repo);

        svc.registerInspectionEquipment("  ", "이름", null, null);

        verify(repo, never()).save(any());
    }
}
