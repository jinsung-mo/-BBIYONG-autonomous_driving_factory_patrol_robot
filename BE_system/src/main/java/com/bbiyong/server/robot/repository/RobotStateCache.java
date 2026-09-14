package com.bbiyong.server.robot.repository;

import com.bbiyong.server.robot.domain.RobotState;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class RobotStateCache {
    // 로봇 상태는 실제 텔레메트리/연결로만 채운다. 가짜 프리로드는 하지 않는다
    // (미연결 로봇이 순찰 중처럼 보이던 버그 방지 — S15P11E101-500).
    private final Map<String, RobotState> cache = new ConcurrentHashMap<>();

    public void updateState(String robotId, RobotState state) {
        cache.put(robotId, state);
    }

    public RobotState getState(String robotId) {
        return cache.get(robotId);
    }

    public List<RobotState> getAllStates() {
        return new ArrayList<>(cache.values());
    }
}
