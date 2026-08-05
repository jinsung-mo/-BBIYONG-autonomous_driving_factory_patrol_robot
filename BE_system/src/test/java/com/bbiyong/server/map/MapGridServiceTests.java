package com.bbiyong.server.map;

import com.bbiyong.server.map.domain.MapArtifact;
import com.bbiyong.server.map.dto.MapGridResponse;
import com.bbiyong.server.map.repository.MapArtifactRepository;
import com.bbiyong.server.map.service.MapGridService;
import com.bbiyong.server.map.service.MapStorageService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.web.server.ResponseStatusException;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 3D 압출용 맵 벽 격자 생성 검증. (S15P11E101-728)
 */
class MapGridServiceTests {

    private final MapArtifactRepository repository = mock(MapArtifactRepository.class);
    private final MapStorageService storageService = mock(MapStorageService.class);
    private final MapGridService service = new MapGridService(repository, storageService);

    /** 좌측 절반 검정(벽), 우측 절반 흰색(자유)인 20x10 PNG. */
    private static byte[] halfWallPng() throws Exception {
        BufferedImage img = new BufferedImage(20, 10, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = img.createGraphics();
        g.setColor(Color.WHITE);
        g.fillRect(0, 0, 20, 10);
        g.setColor(Color.BLACK);
        g.fillRect(0, 0, 10, 10);
        g.dispose();
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ImageIO.write(img, "png", baos);
        return baos.toByteArray();
    }

    private MapArtifact artifact(String id) {
        MapArtifact a = new MapArtifact();
        a.setId(id);
        a.setKind("FLOORPLAN");
        a.setFilePath("robot/" + id + ".png");
        a.setResolution(0.05);
        a.setOriginX(-1.0);
        a.setOriginY(-2.0);
        a.setOriginYaw(0.0);
        return a;
    }

    @Test
    @DisplayName("맵 이미지가 다운샘플 이진 격자와 셀 단위 좌표 메타로 변환된다")
    void buildsDownsampledWallGrid() throws Exception {
        MapArtifact a = artifact("map-1");
        when(repository.findById("map-1")).thenReturn(Optional.of(a));
        when(storageService.load(a.getFilePath())).thenReturn(new ByteArrayResource(halfWallPng()));

        MapGridResponse grid = service.getGrid("map-1", 10, null);

        // 20x10, maxCells=10 → cellSizePx=2, cols=10, rows=5
        assertThat(grid.cellSizePx()).isEqualTo(2);
        assertThat(grid.cols()).isEqualTo(10);
        assertThat(grid.rows()).isEqualTo(5);
        assertThat(grid.cells()).hasSize(5);
        // 좌측 5셀 벽('1'), 우측 5셀 자유('0')
        assertThat(grid.cells()).allSatisfy(row -> assertThat(row).isEqualTo("1111100000"));
        // 셀 실측 크기 = 0.05 m/px × 2 px
        assertThat(grid.cellResolution()).isEqualTo(0.1);
        assertThat(grid.originX()).isEqualTo(-1.0);
        assertThat(grid.kind()).isEqualTo("FLOORPLAN");
    }

    @Test
    @DisplayName("maxCells/threshold 는 허용 범위로 클램프된다")
    void clampsParameters() throws Exception {
        MapArtifact a = artifact("map-2");
        when(repository.findById("map-2")).thenReturn(Optional.of(a));
        when(storageService.load(a.getFilePath())).thenReturn(new ByteArrayResource(halfWallPng()));

        // maxCells=1 → MIN(16) 클램프. 20px/16 → cellSizePx=2 (ceil(20/16)=2)
        MapGridResponse grid = service.getGrid("map-2", 1, 9999);
        assertThat(grid.cellSizePx()).isEqualTo(2);
    }

    @Test
    @DisplayName("미존재 맵은 404")
    void missingMapReturns404() {
        when(repository.findById(any())).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.getGrid("nope", null, null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404");
    }

    @Test
    @DisplayName("활성 맵이 없으면 404")
    void missingActiveMapReturns404() {
        when(repository.findFirstByActiveTrueOrderByCreatedAtDesc()).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.getActiveGrid(null, null))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("404");
    }
}
