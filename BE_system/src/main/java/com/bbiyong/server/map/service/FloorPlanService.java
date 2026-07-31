package com.bbiyong.server.map.service;

import com.bbiyong.server.map.domain.MapArtifact;
import com.bbiyong.server.map.dto.MapResponses;
import com.bbiyong.server.map.floorplan.FloorPlanRenderer;
import com.bbiyong.server.map.repository.MapArtifactRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.Resource;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * 매핑 완료 시 최신 RAW 점유격자를 정제해 2D 도면(FLOORPLAN)을 생성·저장하고 활성 맵으로 지정한다.
 * (S15P11E101-518)
 */
@Slf4j
@Service
public class FloorPlanService {

    private static final String STORAGE_FILESYSTEM = "FILESYSTEM";

    private final MapArtifactRepository mapRepository;
    private final MapStorageService storageService;
    private final MapService mapService;
    private final FloorPlanRenderer renderer = new FloorPlanRenderer();

    public FloorPlanService(MapArtifactRepository mapRepository,
                            MapStorageService storageService,
                            MapService mapService) {
        this.mapRepository = mapRepository;
        this.storageService = storageService;
        this.mapService = mapService;
    }

    /**
     * 로봇의 최신 RAW 맵을 정제해 FLOORPLAN 도면을 생성·활성화한다.
     * 원본이 없거나 이미지 처리에 실패하면 비어 있는 Optional 반환(회귀 없음).
     */
    @Transactional
    public Optional<MapResponses.Detail> generateFloorPlan(String robotId) {
        List<MapArtifact> raws = mapRepository.findLatestRaw(robotId, PageRequest.of(0, 1));
        if (raws.isEmpty()) {
            log.warn("도면 생성 스킵: 로봇 [{}] 의 원본 맵이 없습니다.", robotId);
            return Optional.empty();
        }
        MapArtifact raw = raws.get(0);

        try {
            Resource resource = storageService.load(raw.getFilePath());
            BufferedImage src;
            try (InputStream in = resource.getInputStream()) {
                src = ImageIO.read(in);
            }
            if (src == null) {
                log.warn("도면 생성 스킵: 원본 맵 이미지를 읽을 수 없습니다 (id={}).", raw.getId());
                return Optional.empty();
            }

            BufferedImage plan = renderer.render(src);
            byte[] png;
            try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
                ImageIO.write(plan, "png", baos);
                png = baos.toByteArray();
            }
            String storedPath = storageService.storeBytes(png, robotId, ".png");

            MapArtifact floor = new MapArtifact();
            floor.setRobotId(robotId);
            floor.setName((raw.getName() != null ? raw.getName() : "map") + "_plan");
            floor.setStorageType(STORAGE_FILESYSTEM);
            floor.setFilePath(storedPath);
            floor.setWidthPx(plan.getWidth());
            floor.setHeightPx(plan.getHeight());
            // 좌표 정렬 메타는 원본에서 승계(동일 픽셀 격자)
            floor.setResolution(raw.getResolution());
            floor.setOriginX(raw.getOriginX());
            floor.setOriginY(raw.getOriginY());
            floor.setOriginYaw(raw.getOriginYaw());
            floor.setFileSizeBytes((long) png.length);
            floor.setKind("FLOORPLAN");
            floor.setSourceMapId(raw.getId());
            floor.setCreatedAt(Instant.now());
            MapArtifact saved = mapRepository.save(floor);

            MapResponses.Detail detail = mapService.setActive(saved.getId());
            log.info("도면 생성 완료: robot [{}] raw={} -> floorplan={} ({}x{})",
                    robotId, raw.getId(), saved.getId(), plan.getWidth(), plan.getHeight());
            return Optional.of(detail);
        } catch (Exception e) {
            log.error("도면 생성 실패 (robot [{}], raw={}): {}", robotId, raw.getId(), e.getMessage(), e);
            return Optional.empty();
        }
    }
}
