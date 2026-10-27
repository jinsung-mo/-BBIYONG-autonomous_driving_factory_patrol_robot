package com.bbiyong.server.wss;

import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.HashSet;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

@Slf4j
@Component
public class RobotWebSocketSessionManager {

    // 두 방향의 소유권을 하나의 상태로 갱신한다. 개별 ConcurrentHashMap 연산만으로는
    // 재접속과 종료 콜백 사이의 조회-제거 경합을 막을 수 없다.
    private final Object sessionLock = new Object();
    private final Map<String, WebSocketSession> robotSessions = new HashMap<>();
    private final Map<String, String> sessionIdToRobotId = new HashMap<>();
    private final ObjectMapper objectMapper;

    public RobotWebSocketSessionManager(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /**
     * 로봇 세션을 등록한다. 새 등록(최초 연결 또는 세션 교체·재연결)이면 true 를 반환한다.
     * 호출측은 true 일 때만 연결(ONLINE) 이벤트를 발행해 패킷마다 중복 발행을 막는다. (S15P11E101-683)
     */
    public boolean register(String robotId, WebSocketSession session) {
        if (robotId == null || robotId.trim().isEmpty() || session == null) {
            return false;
        }
        String sessionId = session.getId();
        WebSocketSession existing;
        synchronized (sessionLock) {
            // 핸들러의 사전 검사와 등록 사이에도 다른 패킷이 들어올 수 있으므로,
            // 한 세션이 다른 로봇에 동시에 등록되는 상황은 여기서도 거부한다.
            String boundRobotId = sessionIdToRobotId.get(sessionId);
            if (boundRobotId != null && !boundRobotId.equals(robotId)) {
                return false;
            }
            existing = robotSessions.get(robotId);
            if (existing != null && existing.getId().equals(sessionId)) {
                return false;
            }
            if (existing != null) {
                sessionIdToRobotId.remove(existing.getId(), robotId);
            }
            // 새 소유권을 먼저 원자적으로 게시한다. 이후 옛 세션의 종료 콜백은
            // 새 세션을 제거하지도, OFFLINE 발행용 robotId를 반환하지도 못한다.
            robotSessions.put(robotId, session);
            sessionIdToRobotId.put(sessionId, robotId);
        }
        // close는 외부 I/O이며 동기 종료 콜백을 실행할 수도 있다. 상태 락 밖에서 호출한다.
        if (existing != null) {
            closeQuietly(existing, robotId);
        }
        log.info("Registered new WSS session [{}] for robot [{}]", sessionId, robotId);
        return true;
    }

    /** 교체된 옛 세션을 닫는다. 실패해도 신규 등록에는 영향을 주지 않는다. */
    private void closeQuietly(WebSocketSession session, String robotId) {
        try {
            if (session.isOpen()) {
                session.close();
                log.info("Closed stale WSS session [{}] for robot [{}] (replaced by reconnect)",
                        session.getId(), robotId);
            }
        } catch (Exception e) {
            log.warn("Failed to close stale WSS session [{}] for robot [{}]: {}",
                    session.getId(), robotId, e.getMessage());
        }
    }

    /**
     * 종료된 세션이 여전히 해당 로봇의 현재 세션일 때만 매핑을 제거하고 robotId를 반환한다.
     * 교체된 세션의 늦은 콜백·중복 콜백은 null을 반환해 OFFLINE 오방송을 막는다.
     */
    public String unregisterBySessionId(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        String robotId;
        synchronized (sessionLock) {
            robotId = sessionIdToRobotId.remove(sessionId);
            if (robotId == null) {
                return null;
            }
            WebSocketSession current = robotSessions.get(robotId);
            if (current == null || !sessionId.equals(current.getId())
                    || !robotSessions.remove(robotId, current)) {
                return null;
            }
        }
        log.info("Unregistered WSS session [{}] for robot [{}]", sessionId, robotId);
        return robotId;
    }

    /** 현재 열린 WSS 세션을 가진 로봇 ID 집합. */
    public Set<String> getConnectedRobotIds() {
        Set<String> ids = new HashSet<>();
        Map<String, WebSocketSession> snapshot;
        synchronized (sessionLock) {
            snapshot = new HashMap<>(robotSessions);
        }
        snapshot.forEach((robotId, session) -> {
            if (session != null && session.isOpen()) {
                ids.add(robotId);
            }
        });
        return ids;
    }

    public boolean sendCommand(String robotId, Object commandPayload) {
        WebSocketSession session = currentSession(robotId);
        if (session == null || !session.isOpen()) {
            log.warn("Cannot send command. No active open WSS session found for robot: {}", robotId);
            return false;
        }

        try {
            String jsonStr = objectMapper.writeValueAsString(commandPayload);
            session.sendMessage(new TextMessage(jsonStr));
            log.info("Sent WSS command to [{}] ({})", robotId, jsonStr);
            return true;
        } catch (Exception e) {
            log.error("Failed to send WSS command to robot [{}]: {}", robotId, e.getMessage(), e);
            return false;
        }
    }

    public boolean isConnected(String robotId) {
        WebSocketSession session = currentSession(robotId);
        return session != null && session.isOpen();
    }

    public String getRobotIdBySessionId(String sessionId) {
        synchronized (sessionLock) {
            return sessionId == null ? null : sessionIdToRobotId.get(sessionId);
        }
    }

    private WebSocketSession currentSession(String robotId) {
        synchronized (sessionLock) {
            return robotSessions.get(robotId);
        }
    }

    public void closeAll() {
        log.info("Closing all active WSS robot sessions...");
        Map<String, WebSocketSession> snapshot;
        synchronized (sessionLock) {
            snapshot = new HashMap<>(robotSessions);
            robotSessions.clear();
            sessionIdToRobotId.clear();
        }
        snapshot.forEach((robotId, session) -> {
            try {
                if (session.isOpen()) {
                    session.close();
                }
            } catch (Exception e) {
                log.error("Error closing WSS session for robot [{}]: {}", robotId, e.getMessage());
            }
        });
    }
}
