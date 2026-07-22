package com.bbiyong.server.wss;

import com.bbiyong.server.robot.repository.RobotStateCache;
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public class RobotWebSocketTests {

    @LocalServerPort
    private int port;

    @Autowired
    private RobotStateCache robotStateCache;

    @Autowired
    private RobotWebSocketSessionManager sessionManager;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    @DisplayName("WSS - 로봇 텔레메트리 전송 시 세션 등록 및 메모리 캐시 갱신 검증")
    void testRobotWebSocketTelemetry() throws Exception {
        String wsUrl = "ws://localhost:" + port + "/ws/robot";
        StandardWebSocketClient client = new StandardWebSocketClient();

        BlockingQueue<String> receivedMessages = new ArrayBlockingQueue<>(10);

        WebSocketSession session = client.execute(new TextWebSocketHandler() {
            @Override
            protected void handleTextMessage(WebSocketSession session, TextMessage message) {
                receivedMessages.add(message.getPayload());
            }
        }, wsUrl).get(5, TimeUnit.SECONDS);

        assertThat(session.isOpen()).isTrue();

        String telemetryJson = """
            {
              "source": "robot",
              "type": "TELEMETRY",
              "robot_id": "orinka_wss_test",
              "location": { "x": 10.5, "y": 20.3, "yaw": 1.2 },
              "battery": 88.5,
              "status": "AUTO_PATROL"
            }
            """;

        session.sendMessage(new TextMessage(telemetryJson));

        // Allow asynchronous event processing
        Thread.sleep(500);

        assertThat(sessionManager.isConnected("orinka_wss_test")).isTrue();

        var state = robotStateCache.getState("orinka_wss_test");
        assertThat(state).isNotNull();
        assertThat(state.getRobotId()).isEqualTo("orinka_wss_test");
        assertThat(state.getBattery()).isEqualTo(88.5);

        // Test downstream command sending via sessionManager
        boolean sent = sessionManager.sendCommand("orinka_wss_test", java.util.Map.of("command", "DRIVE", "linear", 0.5, "angular", -0.1));
        assertThat(sent).isTrue();

        String receivedCommand = receivedMessages.poll(3, TimeUnit.SECONDS);
        assertThat(receivedCommand).isNotNull();
        assertThat(receivedCommand).contains("DRIVE");

        session.close();
        Thread.sleep(300);
        assertThat(sessionManager.isConnected("orinka_wss_test")).isFalse();
    }
}
