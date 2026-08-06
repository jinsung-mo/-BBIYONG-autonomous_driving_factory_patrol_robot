package com.bbiyong.server.zone.service;

import com.bbiyong.server.equipment.domain.Equipment;
import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.map.domain.MapArtifact;
import com.bbiyong.server.map.repository.MapArtifactRepository;
import com.bbiyong.server.waypoint.repository.WaypointRepository;
import com.bbiyong.server.zone.domain.Zone;
import com.bbiyong.server.zone.dto.ZoneDtos.ResolveResponse;
import com.bbiyong.server.zone.dto.ZoneDtos.ZoneRequest;
import com.bbiyong.server.zone.repository.ZoneRepository;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 구역 서비스: 좌표 정규화, resolve 우선순위(구역>랜드마크>좌표), 겹침 시 소면적 우선, 격자 시드 검증.
 */
class ZoneServiceTests {

    private final ZoneRepository zoneRepository = mock(ZoneRepository.class);
    private final EquipmentRepository equipmentRepository = mock(EquipmentRepository.class);
    private final WaypointRepository waypointRepository = mock(WaypointRepository.class);
    private final MapArtifactRepository mapRepository = mock(MapArtifactRepository.class);
    private final ZoneService service =
            new ZoneService(zoneRepository, equipmentRepository, waypointRepository, mapRepository);

    private static Zone zone(String name, double x1, double y1, double x2, double y2) {
        Zone z = new Zone();
        z.setId(java.util.UUID.randomUUID().toString());
        z.setName(name);
        z.setX1(x1);
        z.setY1(y1);
        z.setX2(x2);
        z.setY2(y2);
        z.setCreatedAt(Instant.now());
        return z;
    }

    @Test
    void createNormalizesSwappedCoordinates() {
        when(zoneRepository.save(any(Zone.class))).thenAnswer(inv -> inv.getArgument(0));

        Zone saved = service.create(new ZoneRequest("창고", 5.0, 4.0, 1.0, 2.0)); // 뒤집힌 좌표

        assertThat(saved.getX1()).isEqualTo(1.0);
        assertThat(saved.getX2()).isEqualTo(5.0);
        assertThat(saved.getY1()).isEqualTo(2.0);
        assertThat(saved.getY2()).isEqualTo(4.0);
    }

    @Test
    void createRejectsZeroArea() {
        assertThatThrownBy(() -> service.create(new ZoneRequest("선", 1.0, 1.0, 1.0, 5.0)))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    void resolvePrefersSmallerZoneAndAppendsNearbyLandmark() {
        when(zoneRepository.findAll()).thenReturn(List.of(
                zone("공장 전체", -10, -10, 10, 10),
                zone("창고", 0, 0, 2, 2)));
        Equipment panel = new Equipment();
        panel.setEquipmentId("panel_A");
        panel.setName("분전반 A");
        panel.setX(1.5);
        panel.setY(1.0);
        when(equipmentRepository.findAll()).thenReturn(List.of(panel));
        when(waypointRepository.findAll()).thenReturn(List.of());

        ResolveResponse r = service.resolve(1.0, 1.0);

        assertThat(r.zoneName()).isEqualTo("창고");                    // 겹침 → 소면적 우선
        assertThat(r.nearest().name()).isEqualTo("분전반 A");
        assertThat(r.nearest().distanceM()).isEqualTo(0.5);
        assertThat(r.label()).isEqualTo("창고 · 분전반 A 근처(0.5m)");
    }

    @Test
    void resolveFallsBackToLandmarkThenCoordinates() {
        when(zoneRepository.findAll()).thenReturn(List.of());
        Equipment panel = new Equipment();
        panel.setEquipmentId("panel_B");
        panel.setName("분전반 B");
        panel.setX(3.0);
        panel.setY(4.0);
        when(equipmentRepository.findAll()).thenReturn(List.of(panel));
        when(waypointRepository.findAll()).thenReturn(List.of());

        ResolveResponse withLandmark = service.resolve(0.0, 0.0); // 거리 5.0m
        assertThat(withLandmark.zoneName()).isNull();
        assertThat(withLandmark.label()).isEqualTo("분전반 B 근처(5.0m)");

        when(equipmentRepository.findAll()).thenReturn(List.of());
        ResolveResponse coordsOnly = service.resolve(0.06, -0.08);
        assertThat(coordsOnly.label()).isEqualTo("(0.1, -0.1) m");
    }

    @Test
    void seedGridConflictsWhenZonesExistWithoutReplace() {
        when(zoneRepository.findAll()).thenReturn(List.of(zone("기존", 0, 0, 1, 1)));

        assertThatThrownBy(() -> service.seedGrid(3, 3, false))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("이미 정의된 구역");
    }

    @Test
    void seedGridCreatesRowsByColsFromActiveMapBounds() {
        when(zoneRepository.findAll()).thenReturn(List.of());
        MapArtifact map = new MapArtifact();
        map.setResolution(0.1);
        map.setOriginX(-3.0);
        map.setOriginY(-3.0);
        map.setWidthPx(60);   // 6m
        map.setHeightPx(60);  // 6m
        when(mapRepository.findFirstByActiveTrueOrderByCreatedAtDesc()).thenReturn(Optional.of(map));
        when(zoneRepository.saveAll(anyList())).thenAnswer(inv -> inv.getArgument(0));

        List<Zone> zones = service.seedGrid(3, 3, false);

        assertThat(zones).hasSize(9);
        assertThat(zones.get(0).getName()).isEqualTo("구역 A1");
        // A1 = 좌상단: x [-3,-1], y [1,3] (월드 y 최대가 이미지 상단)
        assertThat(zones.get(0).getX1()).isEqualTo(-3.0);
        assertThat(zones.get(0).getX2()).isEqualTo(-1.0);
        assertThat(zones.get(0).getY2()).isEqualTo(3.0);
        assertThat(zones.get(0).getY1()).isEqualTo(1.0);
        assertThat(zones.get(8).getName()).isEqualTo("구역 C3");
    }
}
