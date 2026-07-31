package com.bbiyong.server.waypoint.service;

import com.bbiyong.server.waypoint.domain.Waypoint;
import com.bbiyong.server.waypoint.dto.WaypointRequest;
import com.bbiyong.server.waypoint.dto.WaypointResponses;
import com.bbiyong.server.waypoint.repository.WaypointRepository;
import com.bbiyong.server.wss.RobotWebSocketSessionManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Slf4j
@Service
public class WaypointService {

    static final String DEFAULT_ROBOT_ID = "orinka_01";

    private final WaypointRepository repository;
    private final RobotWebSocketSessionManager sessionManager;

    public WaypointService(WaypointRepository repository, RobotWebSocketSessionManager sessionManager) {
        this.repository = repository;
        this.sessionManager = sessionManager;
    }

    /** 순찰 지점 1개 추가(지도 클릭). seq 미지정 시 맨 뒤로. */
    @Transactional
    public WaypointResponses.Item add(String robotId, WaypointRequest req) {
        String rid = resolveRobotId(robotId);
        List<Waypoint> existing = repository.findByRobotIdOrderBySeqAscCreatedAtAsc(rid);
        int seq = req.seq() != null ? req.seq() : nextSeq(existing);

        Waypoint w = new Waypoint();
        w.setRobotId(rid);
        w.setName(req.name());
        w.setX(req.x());
        w.setY(req.y());
        w.setYaw(req.yaw());
        w.setSeq(seq);
        w.setCreatedAt(Instant.now());
        return WaypointResponses.Item.of(repository.save(w));
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
        if (reqs == null) {
            return List.of();
        }
        Instant now = Instant.now();
        List<Waypoint> saved = new ArrayList<>();
        for (int i = 0; i < reqs.size(); i++) {
            WaypointRequest req = reqs.get(i);
            if (req.x() == null || req.y() == null) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "waypoint x, y 는 필수입니다.");
            }
            Waypoint w = new Waypoint();
            w.setRobotId(rid);
            w.setName(req.name());
            w.setX(req.x());
            w.setY(req.y());
            w.setYaw(req.yaw());
            w.setSeq(req.seq() != null ? req.seq() : i);
            w.setCreatedAt(now);
            saved.add(repository.save(w));
        }
        return WaypointResponses.items(saved);
    }

    @Transactional
    public void delete(String id) {
        if (!repository.existsById(id)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "순찰 지점을 찾을 수 없습니다: " + id);
        }
        repository.deleteById(id);
    }

    /**
     * 저장된 순찰 경로를 로봇에 하달한다. {command:SET_PATROL_ROUTE, waypoints:[...]}.
     * 로봇 미연결 시에도 200(경고 로그) — 저장은 이미 되어 있으므로 재연결 후 재하달 가능.
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
