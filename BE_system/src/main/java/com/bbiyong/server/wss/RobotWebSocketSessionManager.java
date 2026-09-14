package com.bbiyong.server.wss;

import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
public class RobotWebSocketSessionManager {

    private final Map<String, WebSocketSession> robotSessions = new ConcurrentHashMap<>();
    private final Map<String, String> sessionIdToRobotId = new ConcurrentHashMap<>();
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
        WebSocketSession existing = robotSessions.get(robotId);
        if (existing == null || !existing.getId().equals(session.getId())) {
            // 재접속(같은 robotId, 새 세션): 옛 세션의 매핑을 먼저 지우고 닫는다.
            // 지우지 않으면 옛 세션이 뒤늦게 close 될 때 unregisterBySessionId 가
            // 신규 세션의 robotSessions 매핑을 삭제해 살아있는 로봇이 오프라인으로
            // 오인(명령 전송 불가·OFFLINE 오방송)되는 버그가 있었다. (S15P11E101-715)
            if (existing != null) {
                sessionIdToRobotId.remove(existing.getId());
                closeQuietly(existing, robotId);
            }
            robotSessions.put(robotId, session);
            sessionIdToRobotId.put(session.getId(), robotId);
            log.info("Registered new WSS session [{}] for robot [{}]", session.getId(), robotId);
            return true;
        }
        return false;
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
     * 세션 종료 시 매핑을 제거하고, 해당 세션이 담당하던 robotId 를 반환한다(없으면 null).
     * 호출측이 오프라인 처리/브로드캐스트를 이어갈 수 있도록 robotId 를 돌려준다.
     */
    public String unregisterBySessionId(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        String robotId = sessionIdToRobotId.remove(sessionId);
        if (robotId != null) {
            robotSessions.remove(robotId);
            log.info("Unregistered WSS session [{}] for robot [{}]", sessionId, robotId);
        }
        return robotId;
    }

    /** 현재 열린 WSS 세션을 가진 로봇 ID 집합. */
    public Set<String> getConnectedRobotIds() {
        Set<String> ids = new HashSet<>();
        robotSessions.forEach((robotId, session) -> {
            if (session != null && session.isOpen()) {
                ids.add(robotId);
            }
        });
        return ids;
    }

    public boolean sendCommand(String robotId, Object commandPayload) {
        WebSocketSession session = robotSessions.get(robotId);
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
        WebSocketSession session = robotSessions.get(robotId);
        return session != null && session.isOpen();
    }

    public String getRobotIdBySessionId(String sessionId) {
        return sessionId == null ? null : sessionIdToRobotId.get(sessionId);
    }

    public void closeAll() {
        log.info("Closing all active WSS robot sessions...");
        robotSessions.forEach((robotId, session) -> {
            try {
                if (session.isOpen()) {
                    session.close();
                }
            } catch (Exception e) {
                log.error("Error closing WSS session for robot [{}]: {}", robotId, e.getMessage());
            }
        });
        robotSessions.clear();
        sessionIdToRobotId.clear();
    }
}
