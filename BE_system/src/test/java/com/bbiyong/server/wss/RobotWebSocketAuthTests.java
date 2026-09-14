package com.bbiyong.server.wss;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.net.URI;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * /ws/robot 핸드셰이크 토큰 인증의 실제 배선(인터셉터 등록) 검증. (S15P11E101-596)
 *
 * <p>토큰을 설정한 상태에서 (1) 토큰 없는 연결은 거부되고 (2) 올바른 토큰 헤더 연결은 수락되는지 확인.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "bbiyong.robot.upload-token=itest-robot-secret")
class RobotWebSocketAuthTests {

    private static final String TOKEN = "itest-robot-secret";

    @LocalServerPort
    private int port;

    private String wsUrl() {
        return "ws://localhost:" + port + "/ws/robot";
    }

    @Test
    @DisplayName("토큰 없는 핸드셰이크는 거부된다(401)")
    void handshakeWithoutTokenRejected() {
        StandardWebSocketClient client = new StandardWebSocketClient();
        assertThatThrownBy(() ->
                client.execute(new TextWebSocketHandler() {}, wsUrl()).get(5, TimeUnit.SECONDS))
                .isInstanceOf(ExecutionException.class);
    }

    @Test
    @DisplayName("올바른 X-Robot-Token 헤더 핸드셰이크는 수락된다")
    void handshakeWithValidTokenAccepted() throws Exception {
        StandardWebSocketClient client = new StandardWebSocketClient();
        WebSocketHttpHeaders headers = new WebSocketHttpHeaders();
        headers.add(RobotHandshakeAuthInterceptor.HEADER, TOKEN);

        WebSocketSession session = client.execute(
                new TextWebSocketHandler() {}, headers, URI.create(wsUrl())).get(5, TimeUnit.SECONDS);

        assertThat(session.isOpen()).isTrue();
        session.close();
    }
}
