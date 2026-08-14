package com.bbiyong.server.waypoint.service;

import com.bbiyong.server.sync.ResourceChangedEvent;
import com.bbiyong.server.waypoint.domain.Waypoint;
import com.bbiyong.server.waypoint.dto.WaypointRequest;
import com.bbiyong.server.waypoint.dto.WaypointResponses;
import com.bbiyong.server.waypoint.repository.WaypointRepository;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Slf4j
@Service
public class WaypointService {

    static final String DEFAULT_ROBOT_ID = "orinka_01";

    /**
     * 로봇 patrol node(navigation_orchestrator.validate_route)와 동일한 검증 상한.
     * 경로가 로봇에 하달되기 전에 API 단계에서 먼저 거절해 로봇 측 늦은 실패를 막는다. (S15P11E101-620)
     */
    public static final int MAX_WAYPOINTS = 500;
    public static final int MAX_NAME_LEN = 120;

    private final WaypointRepository repository;
    private final RobotWebSocketSessionManager sessionManager;
    private final ApplicationEventPublisher eventPublisher;

    public WaypointService(WaypointRepository repository, RobotWebSocketSessionManager sessionManager,
                           ApplicationEventPublisher eventPublisher) {
        this.repository = repository;
        this.sessionManager = sessionManager;
        this.eventPublisher = eventPublisher;
    }

    /** 순찰 지점 1개 추가(지도 클릭). seq 미지정 시 맨 뒤로. */
    @Transactional
    public WaypointResponses.Item add(String robotId, WaypointRequest req) {
        String rid = resolveRobotId(robotId);
        List<Waypoint> existing = repository.findByRobotIdOrderBySeqAscCreatedAtAsc(rid);
        int seq = req.seq() != null ? req.seq() : nextSeq(existing);
        if (seq < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "waypoint seq 는 0 이상이어야 합니다.");
        }

        Waypoint w = new Waypoint();
        w.setRobotId(rid);
        w.setName(clampName(req.name()));
        w.setX(requireFinite(req.x(), "x"));
        w.setY(requireFinite(req.y(), "y"));
        w.setYaw(normalizeYaw(req.yaw()));
        w.setSeq(seq);
        w.setCreatedAt(Instant.now());
        WaypointResponses.Item item = WaypointResponses.Item.of(repository.save(w));
        // 다른 접속자 화면도 같은 경로를 봐야 한다 — 커밋 후 /topic/sync 로 재조회를 알린다.
        eventPublisher.publishEvent(new ResourceChangedEvent("patrol-route", rid));
        return item;
    }

    @Transactional(readOnly = true)
    public List<WaypointResponses.Item> list(String robotId) {
        return WaypointResponses.items(
                repository.findByRobotIdOrderBySeqAscCreatedAtAsc(resolveRobotId(robotId)));
    }

    /** 순찰 경로 전체(로봇별, 순서대로). 지점들의 집합을 하나의 경로로 반환한다. */
    @Transactional(readOnly = true)
    public WaypointResponses.Route getRoute(String robotId) {
        String rid = resolveRobotId(robotId);
        List<WaypointResponses.Item> items = WaypointResponses.items(
                repository.findByRobotIdOrderBySeqAscCreatedAtAsc(rid));
        return new WaypointResponses.Route(rid, items.size(), items);
    }

    /** 순찰 경로 일괄 교체(기존 전부 삭제 후 순서대로 저장). */
    @Transactional
    public List<WaypointResponses.Item> replace(String robotId, List<WaypointRequest> reqs) {
        String rid = resolveRobotId(robotId);
        repository.deleteByRobotId(rid);
        if (reqs == null || reqs.isEmpty()) {
            // 빈 교체도 '전부 삭제' 라는 변경이다 — 다른 접속자 화면에서도 지워져야 한다.
            eventPublisher.publishEvent(new ResourceChangedEvent("patrol-route", rid));
            return List.of();
        }
        if (reqs.size() > MAX_WAYPOINTS) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "순찰 지점은 최대 " + MAX_WAYPOINTS + "개까지 허용됩니다.");
        }
        Instant now = Instant.now();
        Set<Integer> seenSeq = new HashSet<>();
        List<Waypoint> saved = new ArrayList<>();
        for (int i = 0; i < reqs.size(); i++) {
            WaypointRequest req = reqs.get(i);
            int seq = req.seq() != null ? req.seq() : i;
            if (seq < 0 || !seenSeq.add(seq)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "waypoint seq 는 서로 다른 0 이상의 정수여야 합니다: " + seq);
            }
            Waypoint w = new Waypoint();
            w.setRobotId(rid);
            w.setName(clampName(req.name()));
            w.setX(requireFinite(req.x(), "x"));
            w.setY(requireFinite(req.y(), "y"));
            w.setYaw(normalizeYaw(req.yaw()));
            w.setSeq(seq);
            w.setCreatedAt(now);
            saved.add(repository.save(w));
        }
        eventPublisher.publishEvent(new ResourceChangedEvent("patrol-route", rid));
        return WaypointResponses.items(saved);
    }

    @Transactional
    public void delete(String id) {
        // robotId 를 이벤트에 실어야 하므로 존재 확인을 조회로 한다.
        Waypoint w = repository.findById(id)
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "순찰 지점을 찾을 수 없습니다: " + id));
        repository.deleteById(id);
        eventPublisher.publishEvent(new ResourceChangedEvent("patrol-route", w.getRobotId()));
    }

    /**
     * 저장된 순찰 경로를 로봇에 하달한다. {command:SET_PATROL_ROUTE, waypoints:[...]}.
     *
     * <p><b>주의(로봇 계약, S15P11E101-619):</b> SET_PATROL_ROUTE 는 로봇에 경로를 <b>저장만</b> 한다.
     * 실제 순찰은 저장된 경로가 있는 상태에서 {@code SET_MODE mode=autonomy} 를 받아야 시작된다.
     * 경로 저장과 순찰 시작을 한 번에 하려면 {@link #startPatrol(String)} 를 사용한다.
     * yaw 는 ROS 월드프레임 <b>radians</b> 이며 별도 변환 없이 그대로 전달한다.
     *
     * yaw 미지정(null) 웨이포인트는 null 그대로 보내 로봇의 자동 방향 계산에 맡긴다.
     *
     * <p>로봇 미연결 시에도 200(경고 로그) — 저장은 이미 되어 있으므로 재연결 후 재하달 가능.
     */
    @Transactional(readOnly = true)
    public WaypointResponses.ApplyResult apply(String robotId) {
        String rid = resolveRobotId(robotId);
        List<Waypoint> route = repository.findByRobotIdOrderBySeqAscCreatedAtAsc(rid);

        List<Map<String, Object>> points = new ArrayList<>();
        for (Waypoint w : route) {
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("seq", w.getSeq());
            p.put("x", w.getX());
            p.put("y", w.getY());
            p.put("yaw", w.getYaw());
            p.put("name", w.getName());
            points.add(p);
        }
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("command", "SET_PATROL_ROUTE");
        payload.put("waypoints", points);

        boolean delivered = sessionManager.sendCommand(rid, payload);
        if (!delivered) {
            log.warn("SET_PATROL_ROUTE not delivered (robot [{}] offline): {} points", rid, points.size());
        }
        return new WaypointResponses.ApplyResult("SUCCESS", delivered, points.size());
    }

    /**
     * 저장된 순찰 경로를 로봇에 하달(SET_PATROL_ROUTE)한 뒤 순찰을 시작(SET_MODE mode=autonomy)한다.
     * 로봇 계약상 SET_PATROL_ROUTE 만으로는 순찰이 시작되지 않으므로, 자동 순찰(스케줄러) 및
     * "경로 적용 후 즉시 시작" 시나리오에서 사용한다. (S15P11E101-620)
     *
     * <p>경로가 비어 있으면 로봇이 autonomy 를 거절하므로 SET_MODE 를 보내지 않는다.
     * 로봇 미연결 등으로 하달이 실패해도 예외 없이 결과에 실패 사유를 담아 반환한다.
     */
    @Transactional(readOnly = true)
    public WaypointResponses.PatrolStartResult startPatrol(String robotId) {
        WaypointResponses.ApplyResult applied = apply(robotId);
        if (applied.count() == 0) {
            log.warn("순찰 시작 취소: 저장된 경로가 없습니다 (robot [{}])", resolveRobotId(robotId));
            return new WaypointResponses.PatrolStartResult(
                    "NO_ROUTE", applied.delivered(), false, applied.count());
        }
        String rid = resolveRobotId(robotId);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("command", "SET_MODE");
        payload.put("mode", "autonomy");
        boolean started = sessionManager.sendCommand(rid, payload);
        if (!started) {
            log.warn("SET_MODE autonomy not delivered (robot [{}] offline)", rid);
        }
        return new WaypointResponses.PatrolStartResult(
                "SUCCESS", applied.delivered(), started, applied.count());
    }

    /** x/y 등 필수 좌표는 유한수여야 한다(로봇 validate_route 와 동일: NaN/Infinity 거절). */
    private Double requireFinite(Double v, String field) {
        if (v == null || v.isNaN() || v.isInfinite()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "waypoint " + field + " 는 유한한 숫자여야 합니다.");
        }
        return v;
    }

    /**
     * yaw 는 선택값 — 지정 시 유한수여야 한다.
     *
     * <p>미지정(null)은 그대로 null 로 보존해 로봇에 전달한다. 로봇의
     * patrol_route.py 가 null yaw 를 "가장 가까운 구조물을 바라보도록 자동
     * 계산"으로 해석하기 때문이다({@code _resolve_yaw}/{@code _nearest_structure_yaw}).
     * 과거에는 여기서 0.0 으로 강제해, FE 에서 방향을 비워 자동 계산을 의도해도
     * 실제로는 항상 맵 +X 를 보게 되는 버그였다(2026-08-07 확인).
     */
    private Double normalizeYaw(Double yaw) {
        if (yaw == null) {
            return null;
        }
        return requireFinite(yaw, "yaw");
    }

    /** name 은 로봇 저장 한계(120자)에 맞춰 잘라낸다. */
    private String clampName(String name) {
        if (name == null) {
            return null;
        }
        return name.length() > MAX_NAME_LEN ? name.substring(0, MAX_NAME_LEN) : name;
    }

    private String resolveRobotId(String robotId) {
        return (robotId != null && !robotId.isBlank()) ? robotId : DEFAULT_ROBOT_ID;
    }

    private int nextSeq(List<Waypoint> existing) {
        int max = -1;
        for (Waypoint w : existing) {
            if (w.getSeq() != null && w.getSeq() > max) {
                max = w.getSeq();
            }
        }
        return max + 1;
    }
}
