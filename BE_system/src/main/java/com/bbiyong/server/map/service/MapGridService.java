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
 *
 * <p>FLOORPLAN(정제 도면)은 벽=검정·장애물=중회색(#808080)·배경=흰색으로 렌더되므로,
 * 셀별 명도 밴드(벽 &lt; 64 ≤ 장애물 &lt; 192 ≤ 자유)로 셀 값을 0(자유)/1(벽)/2(장애물) 3값으로 분류한다.
 * 벽 우선(구조가 가장 중요)으로 판정하며, RAW 는 회색이 미탐사를 뜻하므로 기존 이진(0/1)을 유지한다. (S15P11E101-776)
 */
@Slf4j
@Service
public class MapGridService {

    static final int DEFAULT_MAX_CELLS = 200;
    static final int MIN_MAX_CELLS = 16;
    static final int MAX_MAX_CELLS = 512;
    static final int DEFAULT_THRESHOLD = 128;

    // FLOORPLAN 명도 밴드: [0,64)=벽, [64,192)=장애물(#808080≈128), [192,255]=자유. (S15P11E101-776)
    static final int WALL_MAX_LUM = 64;
    static final int OBSTACLE_MAX_LUM = 192;
    static final char CELL_FREE = '0';
    static final char CELL_WALL = '1';
    static final char CELL_OBSTACLE = '2';
    /** 셀을 벽/장애물로 볼 최소 점유 비율(다운샘플 시 경계 잡음 억제, 얇은 구조는 보존). */
    static final double PRESENCE_FRACTION = 0.25;

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

        // FLOORPLAN 은 우리가 렌더한 색(벽=검정/장애물=회색)이 확정적이라 명도 밴드로 3값 분류하고,
        // RAW 는 회색이 미탐사이므로 기존 평균-임계 이진(0/1)을 유지한다.
        boolean floorplan = "FLOORPLAN".equalsIgnoreCase(artifact.getKind());

        List<String> cells = new ArrayList<>(rows);
        StringBuilder row = new StringBuilder(cols);
        for (int gy = 0; gy < rows; gy++) {
            row.setLength(0);
            int y0 = gy * cellSizePx;
            int y1 = Math.min(y0 + cellSizePx, height);
            for (int gx = 0; gx < cols; gx++) {
                int x0 = gx * cellSizePx;
                int x1 = Math.min(x0 + cellSizePx, width);
                row.append(floorplan
                        ? classifyFloorplanCell(image, x0, y0, x1, y1)
                        : classifyBinaryCell(image, x0, y0, x1, y1, threshold));
            }
            cells.add(row.toString());
        }

        Double cellResolution = artifact.getResolution() != null
                ? artifact.getResolution() * cellSizePx : null;
        return new MapGridResponse(
                artifact.getId(), artifact.getKind(), cols, rows, cellSizePx, cellResolution,
                artifact.getOriginX(), artifact.getOriginY(), artifact.getOriginYaw(), cells);
    }

    /** RAW: 셀 평균 휘도 &lt; threshold 면 벽(1). 디코더가 그레이스케일을 3채널 복제하므로 한 채널만 읽는다. */
    private static char classifyBinaryCell(BufferedImage image, int x0, int y0, int x1, int y1, int threshold) {
        long sum = 0;
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                sum += image.getRGB(x, y) & 0xFF;
            }
        }
        long count = (long) (y1 - y0) * (x1 - x0);
        return (sum / (double) count) < threshold ? CELL_WALL : CELL_FREE;
    }

    /**
     * FLOORPLAN: 셀 내 벽(검정)/장애물(회색) 픽셀 비율로 3값 분류. 벽 우선 — 얇은 벽이 다운샘플에
     * 묻히지 않도록 점유 비율 임계를 넘으면 벽으로 본다. 둘 다 미달이면 자유(0).
     */
    private static char classifyFloorplanCell(BufferedImage image, int x0, int y0, int x1, int y1) {
        long wall = 0;
        long obstacle = 0;
        for (int y = y0; y < y1; y++) {
            for (int x = x0; x < x1; x++) {
                int lum = image.getRGB(x, y) & 0xFF;
                if (lum < WALL_MAX_LUM) {
                    wall++;
                } else if (lum < OBSTACLE_MAX_LUM) {
                    obstacle++;
                }
            }
        }
        long cellPx = (long) (y1 - y0) * (x1 - x0);
        long presence = Math.max(1, Math.round(cellPx * PRESENCE_FRACTION));
        if (wall >= presence) {
            return CELL_WALL;
        }
        if (obstacle >= presence) {
            return CELL_OBSTACLE;
        }
        return CELL_FREE;
    }

    private static int clamp(Integer value, int fallback, int min, int max) {
        int v = value != null ? value : fallback;
        return Math.max(min, Math.min(max, v));
    }
}
