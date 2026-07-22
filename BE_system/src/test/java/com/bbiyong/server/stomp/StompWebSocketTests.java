package com.bbiyong.server.stomp;

import com.bbiyong.server.tcp.dto.RobotPacket;
import com.bbiyong.server.tcp.event.RobotTelemetryEvent;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.messaging.converter.StringMessageConverter;
import org.springframework.messaging.simp.stomp.StompFrameHandler;
import org.springframework.messaging.simp.stomp.StompHeaders;
import org.springframework.messaging.simp.stomp.StompSession;
import org.springframework.messaging.simp.stomp.StompSessionHandlerAdapter;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.messaging.WebSocketStompClient;

import java.lang.reflect.Type;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public class StompWebSocketTests {

    @LocalServerPort
    private int port;

    @Autowired
    private ApplicationEventPublisher eventPublisher;

    @Test
    @DisplayName("STOMP - /ws/control 접속 및 /topic/telemetry 브로드캐스팅 수신 검증")
    void testStompTelemetryBroadcasting() throws Exception {
        String stompUrl = "ws://localhost:" + port + "/ws/control";
        WebSocketStompClient stompClient = new WebSocketStompClient(new StandardWebSocketClient());
        stompClient.setMessageConverter(new StringMessageConverter());

        StompSession session = stompClient.connectAsync(stompUrl, new StompSessionHandlerAdapter() {}).get(5, TimeUnit.SECONDS);
        assertThat(session.isConnected()).isTrue();

        BlockingQueue<String> receivedQueue = new ArrayBlockingQueue<>(5);

        session.subscribe("/topic/telemetry", new StompFrameHandler() {
            @Override
            public Type getPayloadType(StompHeaders headers) {
                return String.class;
            }

            @Override
            public void handleFrame(StompHeaders headers, Object payload) {
                if (payload instanceof String jsonStr) {
                    receivedQueue.add(jsonStr);
                }
            }
        });

        // Allow STOMP subscription frame to register with broker
        Thread.sleep(500);

        // Publish Spring Event
        RobotPacket packet = new RobotPacket();
        packet.setSource("robot");
        packet.setType("TELEMETRY");
        packet.setRobotId("orinka_stomp_test");

        eventPublisher.publishEvent(new RobotTelemetryEvent(this, packet));

        String broadcasted = receivedQueue.poll(5, TimeUnit.SECONDS);
        assertThat(broadcasted).isNotNull();
        assertThat(broadcasted).contains("orinka_stomp_test");

        session.disconnect();
    }
}
