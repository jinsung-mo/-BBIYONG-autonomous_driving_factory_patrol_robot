package com.bbiyong.server.common.logging;

import org.slf4j.MDC;

import java.util.UUID;

/**
 * 구조화된 로깅을 위한 MDC (Mapped Diagnostic Context) 유틸리티
 *
 * <p>요청별 추적 ID, 사용자 정보 등을 로그에 자동으로 포함시킵니다.</p>
 *
 * <p>사용 예시:</p>
 * <pre>
 * LoggingContext.setRequestId("req-123");
 * LoggingContext.setUserId(user.getId());
 * log.info("Processing request"); // 로그에 requestId, userId가 자동 포함
 * LoggingContext.clear(); // 요청 처리 후 정리
 * </pre>
 */
public class LoggingContext {

    private static final String REQUEST_ID = "requestId";
    private static final String USER_ID = "userId";
    private static final String ROBOT_ID = "robotId";
    private static final String SESSION_ID = "sessionId";
    private static final String CLIENT_IP = "clientIp";

    private LoggingContext() {
        // 유틸리티 클래스
    }

    /**
     * 새로운 요청 ID를 생성하여 MDC에 설정
     * @return 생성된 요청 ID
     */
    public static String generateAndSetRequestId() {
        String requestId = UUID.randomUUID().toString();
        MDC.put(REQUEST_ID, requestId);
        return requestId;
    }

    /**
     * 요청 ID를 MDC에 설정
     */
    public static void setRequestId(String requestId) {
        MDC.put(REQUEST_ID, requestId);
    }

    /**
     * 사용자 ID를 MDC에 설정
     */
    public static void setUserId(String userId) {
        MDC.put(USER_ID, userId);
    }

    /**
     * 로봇 ID를 MDC에 설정
     */
    public static void setRobotId(String robotId) {
        MDC.put(ROBOT_ID, robotId);
    }

    /**
     * 세션 ID를 MDC에 설정
     */
    public static void setSessionId(String sessionId) {
        MDC.put(SESSION_ID, sessionId);
    }

    /**
     * 클라이언트 IP를 MDC에 설정
     */
    public static void setClientIp(String clientIp) {
        MDC.put(CLIENT_IP, clientIp);
    }

    /**
     * 요청 ID 조회
     */
    public static String getRequestId() {
        return MDC.get(REQUEST_ID);
    }

    /**
     * 사용자 ID 조회
     */
    public static String getUserId() {
        return MDC.get(USER_ID);
    }

    /**
     * MDC 전체 정리 (요청 처리 완료 후 필수 호출)
     */
    public static void clear() {
        MDC.clear();
    }

    /**
     * 특정 키만 제거
     */
    public static void remove(String key) {
        MDC.remove(key);
    }
}
