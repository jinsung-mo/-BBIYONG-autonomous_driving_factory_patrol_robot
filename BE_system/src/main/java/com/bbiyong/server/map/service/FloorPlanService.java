package com.bbiyong.server.map.service;

import com.bbiyong.server.map.domain.MapArtifact;
import com.bbiyong.server.map.dto.MapResponses;
import com.bbiyong.server.map.floorplan.FloorPlanRenderer;
import com.bbiyong.server.map.floorplan.RawMapImageDecoder;
import com.bbiyong.server.map.repository.MapArtifactRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.Resource;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
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
    private final RawMapImageDecoder rawDecoder = new RawMapImageDecoder();

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
            // 원본 PGM(및 구형 PNG/JPEG)을 OpenCV로 디코딩. ImageIO 는 PGM 에서 null 을 반환함. (S15P11E101-616)
            BufferedImage src = rawDecoder.decode(resource);

            // 디코딩 치수가 업로드 메타(widthPx/heightPx)와 다르면 손상 가능성 → 도면 미생성(깨진 도면 활성 방지).
            if (raw.getWidthPx() != null && raw.getHeightPx() != null
                    && (src.getWidth() != raw.getWidthPx() || src.getHeight() != raw.getHeightPx())) {
                log.warn("도면 생성 스킵: RAW 맵 치수가 메타데이터와 불일치 (id={}, decoded={}x{}, meta={}x{}).",
                        raw.getId(), src.getWidth(), src.getHeight(), raw.getWidthPx(), raw.getHeightPx());
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
