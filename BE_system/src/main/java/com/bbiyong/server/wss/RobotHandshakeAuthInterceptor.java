package com.bbiyong.server.wss;

import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.util.StringUtils;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Map;

/**
 * 로봇 원시 WebSocket(/ws/robot) 핸드셰이크 인증. (S15P11E101-596)
 *
 * <p>기존에는 /ws/robot 이 인증 없이 열려 있어, 아무나 연결해 임의 {@code robot_id} 로
 * REGISTER/TELEMETRY 를 보내면 그 로봇으로 등록되는 <b>사칭·세션 탈취</b> 취약점이 있었다.
 * 로봇은 JWT 를 갖지 않으므로, 업로드 인증({@link com.bbiyong.server.auth.security.RobotUploadTokenFilter},
 * S15P11E101-517)과 동일한 공유 시크릿({@code X-Robot-Token})을 핸드셰이크 단계에서 검증한다.
 *
 * <ul>
 *   <li>토큰은 헤더 {@code X-Robot-Token} 또는 쿼리파라미터 {@code token} 으로 전달.</li>
 *   <li>{@link MessageDigest#isEqual}(상수시간 비교)로 타이밍 공격을 방어.</li>
 *   <li>서버에 토큰이 미설정(blank)이면 인증을 강제하지 않는다(개발 안전 기본값 — 업로드 필터와 동일 정책).</li>
 *   <li>검증 실패 시 401 로 핸드셰이크를 거부한다.</li>
 * </ul>
 */
@Slf4j
public class RobotHandshakeAuthInterceptor implements HandshakeInterceptor {

    static final String HEADER = "X-Robot-Token";
    static final String QUERY_PARAM = "token";
    /** 핸드셰이크에서 인증에 성공한 세션임을 표시하는 attribute 키. */
    public static final String ROBOT_AUTHENTICATED = "robotAuthenticated";

    private final String robotToken;

    public RobotHandshakeAuthInterceptor(String robotToken) {
        this.robotToken = robotToken;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   WebSocketHandler wsHandler, Map<String, Object> attributes) {
        if (!StringUtils.hasText(robotToken)) {
            return true; // 토큰 미설정: 인증 비활성(기존과 동일하게 열림)
        }
        String provided = resolveToken(request);
        if (provided != null && constantTimeEquals(provided, robotToken)) {
            attributes.put(ROBOT_AUTHENTICATED, Boolean.TRUE);
            return true;
        }
        response.setStatusCode(HttpStatus.UNAUTHORIZED);
        log.warn("Rejected /ws/robot handshake: missing/invalid {} from {}", HEADER, request.getRemoteAddress());
        return false;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                               WebSocketHandler wsHandler, Exception exception) {
        // no-op
    }

    /** 헤더(X-Robot-Token) 우선, 없으면 쿼리파라미터(token) 에서 토큰을 읽는다. */
    private String resolveToken(ServerHttpRequest request) {
        List<String> header = request.getHeaders().get(HEADER);
        if (header != null && !header.isEmpty() && StringUtils.hasText(header.get(0))) {
            return header.get(0);
        }
        String query = request.getURI().getQuery();
        if (query != null) {
            for (String pair : query.split("&")) {
                int eq = pair.indexOf('=');
                if (eq > 0 && QUERY_PARAM.equals(pair.substring(0, eq))) {
                    return URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
                }
            }
        }
        return null;
    }

    private boolean constantTimeEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }
}
