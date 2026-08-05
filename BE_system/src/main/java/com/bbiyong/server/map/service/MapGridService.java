package com.bbiyong.server.map.service;

import com.bbiyong.server.map.domain.MapArtifact;
import com.bbiyong.server.map.dto.MapGridResponse;
import com.bbiyong.server.map.floorplan.RawMapImageDecoder;
import com.bbiyong.server.map.repository.MapArtifactRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * 맵 이미지를 다운샘플해 3D 압출 연출용 벽 격자를 생성한다. (S15P11E101-728)
 *
 * <p>프로토타입(docs/iso_map_extrude.html)의 buildMask(캔버스 다운샘플 + 휘도 임계값)를
 * 서버로 이전: FE 가 이미지 픽셀을 직접 판독하지 않고 격자 JSON 만 소비하도록 한다.
 *
 * <p>벽 판정: 셀 영역 평균 휘도 &lt; threshold. ROS occupancy grid 관례상
 * 점유(벽)=0(검정), 자유=254(흰색), 미탐사=205(회색)이므로 기본 임계값 128은
 * 미탐사 영역을 자유 공간으로 분류한다.
 */
@Slf4j
@Service
public class MapGridService {

    static final int DEFAULT_MAX_CELLS = 200;
    static final int MIN_MAX_CELLS = 16;
    static final int MAX_MAX_CELLS = 512;
    static final int DEFAULT_THRESHOLD = 128;

    private final MapArtifactRepository mapRepository;
    private final MapStorageService storageService;
    private final RawMapImageDecoder decoder = new RawMapImageDecoder();

    public MapGridService(MapArtifactRepository mapRepository, MapStorageService storageService) {
        this.mapRepository = mapRepository;
        this.storageService = storageService;
    }

    /** 지정 맵의 벽 격자. 미존재 시 404. */
    @Transactional(readOnly = true)
    public MapGridResponse getGrid(String mapId, Integer maxCells, Integer threshold) {
        MapArtifact artifact = mapRepository.findById(mapId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "맵을 찾을 수 없습니다."));
        return build(artifact, maxCells, threshold);
    }

    /** 활성 맵의 벽 격자. 활성 맵이 없으면 404. */
    @Transactional(readOnly = true)
    public MapGridResponse getActiveGrid(Integer maxCells, Integer threshold) {
        MapArtifact artifact = mapRepository.findFirstByActiveTrueOrderByCreatedAtDesc()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "활성 맵이 없습니다."));
        return build(artifact, maxCells, threshold);
    }

    private MapGridResponse build(MapArtifact artifact, Integer maxCellsParam, Integer thresholdParam) {
        int maxCells = clamp(maxCellsParam, DEFAULT_MAX_CELLS, MIN_MAX_CELLS, MAX_MAX_CELLS);
        int threshold = clamp(thresholdParam, DEFAULT_THRESHOLD, 1, 254);

        BufferedImage image;
        try {
            image = decoder.decode(storageService.load(artifact.getFilePath()));
        } catch (IOException e) {
            log.error("맵 격자 생성 실패: 이미지 디코딩 불가 (mapId={}): {}", artifact.getId(), e.getMessage());
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "맵 이미지를 디코딩할 수 없습니다.");
        }

        int width = image.getWidth();
        int height = image.getHeight();
        // 긴 변이 maxCells 이하가 되도록 셀 크기(원본 px)를 정한다.
        int cellSizePx = Math.max(1, (int) Math.ceil(Math.max(width, height) / (double) maxCells));
        int cols = (int) Math.ceil(width / (double) cellSizePx);
        int rows = (int) Math.ceil(height / (double) cellSizePx);

        List<String> cells = new ArrayList<>(rows);
        StringBuilder row = new StringBuilder(cols);
        for (int gy = 0; gy < rows; gy++) {
            row.setLength(0);
            int y0 = gy * cellSizePx;
            int y1 = Math.min(y0 + cellSizePx, height);
            for (int gx = 0; gx < cols; gx++) {
                int x0 = gx * cellSizePx;
                int x1 = Math.min(x0 + cellSizePx, width);
                long sum = 0;
                for (int y = y0; y < y1; y++) {
                    for (int x = x0; x < x1; x++) {
                        // 디코더가 그레이스케일을 RGB 3채널에 복제하므로 한 채널만 읽으면 된다.
                        sum += image.getRGB(x, y) & 0xFF;
                    }
                }
                long count = (long) (y1 - y0) * (x1 - x0);
                double avg = sum / (double) count;
                row.append(avg < threshold ? '1' : '0');
            }
            cells.add(row.toString());
        }

        Double cellResolution = artifact.getResolution() != null
                ? artifact.getResolution() * cellSizePx : null;
        return new MapGridResponse(
                artifact.getId(), artifact.getKind(), cols, rows, cellSizePx, cellResolution,
                artifact.getOriginX(), artifact.getOriginY(), artifact.getOriginYaw(), cells);
    }

    private static int clamp(Integer value, int fallback, int min, int max) {
        int v = value != null ? value : fallback;
        return Math.max(min, Math.min(max, v));
    }
}
