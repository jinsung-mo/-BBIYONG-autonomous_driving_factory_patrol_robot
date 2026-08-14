package com.bbiyong.server.wss;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.http.server.ServletServerHttpResponse;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * /ws/robot 핸드셰이크 토큰 인증 검증. (S15P11E101-596)
 */
class RobotHandshakeAuthInterceptorTests {

    private static final String SECRET = "robot-shared-secret";

    private final MockHttpServletResponse rawResponse = new MockHttpServletResponse();
    private final ServerHttpResponse response = new ServletServerHttpResponse(rawResponse);

    private ServerHttpRequest request(String headerToken, String queryString) {
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/ws/robot");
        if (headerToken != null) {
            req.addHeader(RobotHandshakeAuthInterceptor.HEADER, headerToken);
        }
        if (queryString != null) {
            req.setQueryString(queryString);
        }
        return new ServletServerHttpRequest(req);
    }

    private boolean handshake(String configuredToken, ServerHttpRequest req, Map<String, Object> attrs) {
        return new RobotHandshakeAuthInterceptor(configuredToken)
                .beforeHandshake(req, response, null, attrs);
    }

    @Test
    void blankConfiguredTokenRejectsHandshake() {
        // 정책 변경(S15P11E101-715): 토큰 미설정은 기동 시 fail-fast 로 차단되며,
        // 심층 방어로 이 경로에 도달해도 개방하지 않고 401 거부한다.
        Map<String, Object> attrs = new HashMap<>();
        boolean ok = handshake("", request(null, null), attrs);

        assertThat(ok).isFalse();
        assertThat(rawResponse.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED.value());
        assertThat(attrs).doesNotContainKey(RobotHandshakeAuthInterceptor.ROBOT_AUTHENTICATED);
    }

    @Test
    void validHeaderTokenAccepted() {
        Map<String, Object> attrs = new HashMap<>();
        boolean ok = handshake(SECRET, request(SECRET, null), attrs);

        assertThat(ok).isTrue();
        assertThat(attrs).containsEntry(RobotHandshakeAuthInterceptor.ROBOT_AUTHENTICATED, Boolean.TRUE);
    }

    @Test
    void validQueryParamTokenAccepted() {
        Map<String, Object> attrs = new HashMap<>();
        boolean ok = handshake(SECRET, request(null, "token=" + SECRET), attrs);

        assertThat(ok).isTrue();
        assertThat(attrs).containsEntry(RobotHandshakeAuthInterceptor.ROBOT_AUTHENTICATED, Boolean.TRUE);
    }

    @Test
    void missingTokenRejectedWith401() {
        Map<String, Object> attrs = new HashMap<>();
        boolean ok = handshake(SECRET, request(null, null), attrs);

        assertThat(ok).isFalse();
        assertThat(rawResponse.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED.value());
        assertThat(attrs).doesNotContainKey(RobotHandshakeAuthInterceptor.ROBOT_AUTHENTICATED);
    }

    @Test
    void wrongTokenRejectedWith401() {
        Map<String, Object> attrs = new HashMap<>();
        boolean ok = handshake(SECRET, request("nope", null), attrs);

        assertThat(ok).isFalse();
        assertThat(rawResponse.getStatus()).isEqualTo(HttpStatus.UNAUTHORIZED.value());
    }
}
