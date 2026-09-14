package com.bbiyong.server.map.service;

import com.bbiyong.server.map.domain.MapArtifact;
import com.bbiyong.server.map.dto.MapResponses;
import com.bbiyong.server.map.repository.MapArtifactRepository;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.core.io.ByteArrayResource;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class FloorPlanServiceTests {

    private final MapArtifactRepository repo = mock(MapArtifactRepository.class);
    private final MapStorageService storage = mock(MapStorageService.class);
    private final MapService mapService = mock(MapService.class);
    private final FloorPlanService service = new FloorPlanService(
            repo, storage, mapService, new com.bbiyong.server.map.floorplan.FloorPlanRenderer());

    private byte[] samplePng() throws Exception {
        BufferedImage img = new BufferedImage(16, 16, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < 16; y++) {
            for (int x = 0; x < 16; x++) {
                img.setRGB(x, y, 0xFFFFFF);
            }
        }
        for (int y = 0; y < 16; y++) {
            img.setRGB(8, y, 0x000000); // 벽
        }
        try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            ImageIO.write(img, "png", baos);
            return baos.toByteArray();
        }
    }

    @Test
    void generatesFloorPlanFromLatestRawAndActivates() throws Exception {
        MapArtifact raw = new MapArtifact();
        raw.setId("raw-1");
        raw.setRobotId("orinka_01");
        raw.setName("factory_01");
        raw.setFilePath("orinka_01/raw.png");
        raw.setResolution(0.05);
        raw.setOriginX(-10.0);

        when(repo.findLatestRaw(eq("orinka_01"), any())).thenReturn(List.of(raw));
        when(storage.load("orinka_01/raw.png")).thenReturn(new ByteArrayResource(samplePng()));
        when(storage.storeBytes(any(), eq("orinka_01"), any())).thenReturn("orinka_01/plan.png");
        when(repo.save(any())).thenAnswer(inv -> {
            MapArtifact m = inv.getArgument(0);
            if (m.getId() == null) {
                m.setId("floor-1");
            }
            return m;
        });
        MapArtifact detailStub = new MapArtifact();
        detailStub.setId("floor-1");
        detailStub.setName("factory_01_plan");
        detailStub.setKind("FLOORPLAN");
        detailStub.setCreatedAt(Instant.now());
        when(mapService.setActive("floor-1")).thenReturn(MapResponses.Detail.of(detailStub));

        Optional<MapResponses.Detail> result = service.generateFloorPlan("orinka_01");

        assertThat(result).isPresent();
        assertThat(result.get().kind()).isEqualTo("FLOORPLAN");

        ArgumentCaptor<MapArtifact> captor = ArgumentCaptor.forClass(MapArtifact.class);
        verify(repo).save(captor.capture());
        MapArtifact saved = captor.getValue();
        assertThat(saved.getKind()).isEqualTo("FLOORPLAN");
        assertThat(saved.getSourceMapId()).isEqualTo("raw-1");
        assertThat(saved.getResolution()).isEqualTo(0.05);
        verify(mapService).setActive("floor-1");
    }

    @Test
    void returnsEmptyWhenNoRawMap() {
        when(repo.findLatestRaw(eq("orinka_01"), any())).thenReturn(List.of());
        assertThat(service.generateFloorPlan("orinka_01")).isEmpty();
    }

    @Test
    void skipsWhenDecodedDimensionsMismatchMetadata() throws Exception {
        MapArtifact raw = new MapArtifact();
        raw.setId("raw-2");
        raw.setRobotId("orinka_01");
        raw.setName("factory_01");
        raw.setFilePath("orinka_01/raw.png");
        // 실제 이미지는 16x16 이지만 메타는 다른 치수 → 불일치로 도면 미생성
        raw.setWidthPx(999);
        raw.setHeightPx(999);

        when(repo.findLatestRaw(eq("orinka_01"), any())).thenReturn(List.of(raw));
        when(storage.load("orinka_01/raw.png")).thenReturn(new ByteArrayResource(samplePng()));

        assertThat(service.generateFloorPlan("orinka_01")).isEmpty();
        // 깨진 도면이 저장/활성화되지 않아야 함
        verify(repo, org.mockito.Mockito.never()).save(any());
        verify(mapService, org.mockito.Mockito.never()).setActive(any());
    }
}
