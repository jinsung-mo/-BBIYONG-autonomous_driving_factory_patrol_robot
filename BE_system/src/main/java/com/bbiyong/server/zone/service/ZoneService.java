package com.bbiyong.server.zone.service;

import com.bbiyong.server.equipment.repository.EquipmentRepository;
import com.bbiyong.server.map.domain.MapArtifact;
import com.bbiyong.server.map.repository.MapArtifactRepository;
import com.bbiyong.server.waypoint.repository.WaypointRepository;
import com.bbiyong.server.zone.domain.Zone;
import com.bbiyong.server.zone.dto.ZoneDtos.Landmark;
import com.bbiyong.server.zone.dto.ZoneDtos.ResolveResponse;
import com.bbiyong.server.zone.dto.ZoneDtos.ZoneRequest;
import com.bbiyong.server.zone.repository.ZoneRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * 구역 CRUD·격자 시드·좌표→라벨 변환. (S15P11E101-769)
 *
 * <p>라벨 우선순위: 정의 구역명 → 최근접 랜드마크(설비/웨이포인트) → 좌표 폴백.
 * 겹치는 구역은 더 작은(구체적인) 것을 고른다.
 */
@Slf4j
@Service
public class ZoneService {

    /** 이 거리(m) 이내일 때만 "~ 근처" 라벨에 랜드마크를 붙인다. 너무 멀면 오해만 만든다. */
    static final double NEAR_METERS = 3.0;

    private final ZoneRepository zoneRepository;
    private final EquipmentRepository equipmentRepository;
    private final WaypointRepository waypointRepository;
    private final MapArtifactRepository mapRepository;

    public ZoneService(ZoneRepository zoneRepository,
                       EquipmentRepository equipmentRepository,
                       WaypointRepository waypointRepository,
                       MapArtifactRepository mapRepository) {
        this.zoneRepository = zoneRepository;
        this.equipmentRepository = equipmentRepository;
        this.waypointRepository = waypointRepository;
        this.mapRepository = mapRepository;
    }

    @Transactional(readOnly = true)
    public List<Zone> list() {
        return zoneRepository.findAllByOrderByCreatedAtAsc();
    }

    @Transactional
    public Zone create(ZoneRequest req) {
        return zoneRepository.save(normalized(new Zone(), req));
    }

    @Transactional
    public Zone update(String id, ZoneRequest req) {
        Zone zone = zoneRepository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "구역을 찾을 수 없습니다."));
        return zoneRepository.save(normalized(zone, req));
    }

    @Transactional
    public void delete(String id) {
        if (!zoneRepository.existsById(id)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "구역을 찾을 수 없습니다.");
        }
        zoneRepository.deleteById(id);
    }

    /** 좌표를 정규화(x1<=x2, y1<=y2)하고 면적 0 사각형을 거부한다. */
    private Zone normalized(Zone zone, ZoneRequest req) {
        double x1 = Math.min(req.x1(), req.x2());
        double x2 = Math.max(req.x1(), req.x2());
        double y1 = Math.min(req.y1(), req.y2());
        double y2 = Math.max(req.y1(), req.y2());
        if (x1 == x2 || y1 == y2) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "구역 영역의 넓이가 0 입니다.");
        }
        zone.setName(req.name().trim());
        zone.setX1(x1);
        zone.setY1(y1);
        zone.setX2(x2);
        zone.setY2(y2);
        if (zone.getCreatedAt() == null) {
            zone.setCreatedAt(Instant.now());
        }
        return zone;
    }

    /**
     * 활성 맵 경계로 rows x cols 격자 구역을 시드한다(이름 "구역 A1" 형식, 이후 관리자가 개명).
     * 기존 구역이 있으면 replace=true 일 때만 지우고 다시 만든다.
     */
    @Transactional
    public List<Zone> seedGrid(int rows, int cols, boolean replace) {
        int r = clamp(rows);
        int c = clamp(cols);
        if (!zoneRepository.findAll().isEmpty()) {
            if (!replace) {
                throw new ResponseStatusException(HttpStatus.CONFLICT,
                        "이미 정의된 구역이 있습니다. replace=true 로 다시 생성할 수 있습니다.");
            }
            zoneRepository.deleteAll();
        }
        MapArtifact map = mapRepository.findFirstByActiveTrueOrderByCreatedAtDesc()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "활성 맵이 없습니다."));
        if (map.getResolution() == null || map.getOriginX() == null || map.getOriginY() == null
                || map.getWidthPx() == null || map.getHeightPx() == null) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "활성 맵에 좌표 메타(resolution/origin/size)가 없어 격자를 만들 수 없습니다.");
        }
        double minX = map.getOriginX();
        double minY = map.getOriginY();
        double width = map.getWidthPx() * map.getResolution();
        double height = map.getHeightPx() * map.getResolution();
        double cellW = width / c;
        double cellH = height / r;

        List<Zone> zones = new ArrayList<>(r * c);
        Instant now = Instant.now();
        for (int row = 0; row < r; row++) {
            for (int col = 0; col < c; col++) {
                Zone zone = new Zone();
                // 표기: A1 이 이미지 좌상단(=월드 y 최대) — 사람이 지도를 보는 방향과 맞춘다.
                char rowLetter = (char) ('A' + row);
                zone.setName(String.format(Locale.ROOT, "구역 %c%d", rowLetter, col + 1));
                zone.setX1(minX + col * cellW);
                zone.setX2(minX + (col + 1) * cellW);
                double topY = minY + height - row * cellH;
                zone.setY2(topY);
                zone.setY1(topY - cellH);
                zone.setCreatedAt(now);
                zones.add(zone);
            }
        }
        return zoneRepository.saveAll(zones);
    }

    /** 좌표 → 사람이 읽는 위치 라벨. */
    @Transactional(readOnly = true)
    public ResolveResponse resolve(double x, double y) {
        Optional<Zone> zone = zoneRepository.findAll().stream()
                .filter(z -> z.contains(x, y))
                .min(Comparator.comparingDouble(Zone::area));

        Landmark nearest = nearestLandmark(x, y);

        String label;
        if (zone.isPresent()) {
            label = zone.get().getName();
            if (nearest != null && nearest.distanceM() <= NEAR_METERS) {
                label += " · " + nearest.name() + " 근처(" + fmt(nearest.distanceM()) + "m)";
            }
        } else if (nearest != null) {
            label = nearest.name() + " 근처(" + fmt(nearest.distanceM()) + "m)";
        } else {
            label = "(" + fmt(x) + ", " + fmt(y) + ") m";
        }
        return new ResolveResponse(x, y,
                zone.map(Zone::getId).orElse(null),
                zone.map(Zone::getName).orElse(null),
                nearest, label);
    }

    /** 설비·웨이포인트를 통틀어 가장 가까운 랜드마크. 아무것도 등록돼 있지 않으면 null. */
    private Landmark nearestLandmark(double x, double y) {
        List<Landmark> candidates = new ArrayList<>();
        equipmentRepository.findAll().forEach(e -> {
            if (e.getX() != null && e.getY() != null) {
                candidates.add(new Landmark("EQUIPMENT", e.getEquipmentId(),
                        e.getName() != null ? e.getName() : e.getEquipmentId(),
                        distance(x, y, e.getX(), e.getY())));
            }
        });
        waypointRepository.findAll().forEach(w -> {
            if (w.getX() != null && w.getY() != null) {
                candidates.add(new Landmark("WAYPOINT", w.getId(),
                        w.getName() != null ? w.getName() : "지점",
                        distance(x, y, w.getX(), w.getY())));
            }
        });
        return candidates.stream().min(Comparator.comparingDouble(Landmark::distanceM)).orElse(null);
    }

    private static double distance(double x1, double y1, double x2, double y2) {
        return Math.round(Math.hypot(x1 - x2, y1 - y2) * 10.0) / 10.0;
    }

    private static String fmt(double v) {
        return String.format(Locale.ROOT, "%.1f", v);
    }

    private static int clamp(int v) {
        return Math.max(1, Math.min(10, v));
    }
}
