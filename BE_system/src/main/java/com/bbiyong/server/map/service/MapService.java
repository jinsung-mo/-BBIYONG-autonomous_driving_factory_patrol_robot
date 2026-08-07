package com.bbiyong.server.map.service;

import com.bbiyong.server.map.domain.MapArtifact;
import com.bbiyong.server.map.dto.MapResponses;
import com.bbiyong.server.map.dto.MapUploadRequest;
import com.bbiyong.server.map.repository.MapArtifactRepository;
import com.bbiyong.server.sync.ResourceChangedEvent;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.List;

@Service
public class MapService {

    private static final String STORAGE_FILESYSTEM = "FILESYSTEM";

    private final MapArtifactRepository mapRepository;
    private final MapStorageService storageService;
    private final ApplicationEventPublisher eventPublisher;

    public MapService(MapArtifactRepository mapRepository, MapStorageService storageService,
                      ApplicationEventPublisher eventPublisher) {
        this.mapRepository = mapRepository;
        this.storageService = storageService;
        this.eventPublisher = eventPublisher;
    }

    /** 맵 이미지 파일을 저장하고 메타데이터를 등록한다. */
    @Transactional
    public MapResponses.RegisterResult register(MapUploadRequest meta, MultipartFile file) {
        String storedPath = storageService.store(file, meta.robotId());

        MapArtifact artifact = new MapArtifact();
        artifact.setRobotId(meta.robotId());
        artifact.setName(meta.name() != null && !meta.name().isBlank() ? meta.name() : "map");
        artifact.setStorageType(STORAGE_FILESYSTEM);
        artifact.setFilePath(storedPath);
        artifact.setWidthPx(meta.widthPx());
        artifact.setHeightPx(meta.heightPx());
        artifact.setResolution(meta.resolution());
        artifact.setOriginX(meta.originX());
        artifact.setOriginY(meta.originY());
        artifact.setOriginYaw(meta.originYaw());
        artifact.setFileSizeBytes(file.getSize());
        artifact.setKind("RAW");
        artifact.setCreatedAt(Instant.now());
        MapResponses.RegisterResult result = MapResponses.RegisterResult.of(mapRepository.save(artifact));
        // 저장된 맵 목록이 늘었다 — 열려 있는 다른 관제 화면도 새로 읽게 알린다(/topic/sync).
        eventPublisher.publishEvent(new ResourceChangedEvent("maps", meta.robotId()));
        return result;
    }

    @Transactional(readOnly = true)
    public List<MapResponses.Summary> list() {
        return MapResponses.summaries(mapRepository.findAllByOrderByCreatedAtDesc());
    }

    @Transactional(readOnly = true)
    public MapResponses.Detail getDetail(String id) {
        return MapResponses.Detail.of(findMap(id));
    }

    /** 로봇별 최신 맵. robotId 미지정 시 전체에서 최신 1건. */
    @Transactional(readOnly = true)
    public MapResponses.Detail getLatest(String robotId) {
        MapArtifact artifact = ((robotId == null || robotId.isBlank())
                ? mapRepository.findFirstByOrderByCreatedAtDesc()
                : mapRepository.findFirstByRobotIdOrderByCreatedAtDesc(robotId))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "저장된 맵이 없습니다."));
        return MapResponses.Detail.of(artifact);
    }

    /** 저장된 맵 중 하나를 활성 맵으로 지정한다(단일 활성 — 기존 활성은 해제). */
    @Transactional
    public MapResponses.Detail setActive(String id) {
        MapArtifact target = findMap(id);
        for (MapArtifact prev : mapRepository.findByActiveTrue()) {
            if (!prev.getId().equals(target.getId())) {
                prev.setActive(false);
                mapRepository.save(prev);
            }
        }
        target.setActive(true);
        MapResponses.Detail detail = MapResponses.Detail.of(mapRepository.save(target));
        // 활성 맵 표시(배지)와 목록이 다른 접속자 화면에서도 맞아야 한다.
        // 도면 생성(FloorPlanService)도 저장 직후 이 메서드로 활성화하므로 여기 한 곳이면 된다.
        eventPublisher.publishEvent(new ResourceChangedEvent("maps", target.getRobotId()));
        return detail;
    }

    /** 현재 활성 맵. 없으면 404. */
    @Transactional(readOnly = true)
    public MapResponses.Detail getActive() {
        MapArtifact artifact = mapRepository.findFirstByActiveTrueOrderByCreatedAtDesc()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "활성 맵이 없습니다."));
        return MapResponses.Detail.of(artifact);
    }

    /** 맵 이미지 파일 로드. */
    @Transactional(readOnly = true)
    public StoredFile loadImage(String id) {
        MapArtifact artifact = findMap(id);
        Resource resource = storageService.load(artifact.getFilePath());
        return new StoredFile(resource, storageService.probeContentType(resource, "image/png"));
    }

    private MapArtifact findMap(String id) {
        return mapRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "맵을 찾을 수 없습니다."));
    }

    /** 서빙용 파일 리소스 + content-type 묶음. */
    public record StoredFile(Resource resource, String contentType) {
    }
}
