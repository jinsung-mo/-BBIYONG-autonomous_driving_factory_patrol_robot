package com.bbiyong.server.stomp;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import com.bbiyong.server.wss.dto.RobotPacket;
import com.bbiyong.server.wss.event.RobotFireEvent;
import com.bbiyong.server.wss.event.RobotTelemetryEvent;
import com.bbiyong.server.wss.event.RobotVideoEvent;
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
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.messaging.WebSocketStompClient;

import java.lang.reflect.Type;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
public class StompWebSocketTests {

    @LocalServerPort
    private int port;

    @Autowired
    private ApplicationEventPublisher eventPublisher;

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    /** 유효 JWT 를 담은 CONNECT 헤더. */
    private StompHeaders authHeaders() {
        StompHeaders headers = new StompHeaders();
        headers.add("Authorization", "Bearer " + jwtTokenProvider.generate("admin@bbiyong.io", "ROLE_ADMIN"));
        return headers;
    }

    private StompSession connect(String url) throws Exception {
        WebSocketStompClient stompClient = new WebSocketStompClient(new StandardWebSocketClient());
        stompClient.setMessageConverter(new StringMessageConverter());
        StompSession session = stompClient
                .connectAsync(url, new WebSocketHttpHeaders(), authHeaders(), new StompSessionHandlerAdapter() {})
                .get(5, TimeUnit.SECONDS);
        assertThat(session.isConnected()).isTrue();
        return session;
    }

    @Test
    @DisplayName("STOMP - 토큰 없이 CONNECT 시 연결 거부")
    void testStompConnectRejectedWithoutToken() {
        String stompUrl = "ws://localhost:" + port + "/ws/control";
        WebSocketStompClient stompClient = new WebSocketStompClient(new StandardWebSocketClient());
        stompClient.setMessageConverter(new StringMessageConverter());

        assertThatThrownBy(() -> stompClient
                .connectAsync(stompUrl, new StompSessionHandlerAdapter() {})
                .get(5, TimeUnit.SECONDS))
                .isInstanceOf(ExecutionException.class);
    }

    @Test
    @DisplayName("STOMP - /ws/control 접속 및 /topic/robots 텔레메트리 브로드캐스팅 수신 검증")
    void testStompTelemetryBroadcasting() throws Exception {
        String stompUrl = "ws://localhost:" + port + "/ws/control";
        StompSession session = connect(stompUrl);

        BlockingQueue<String> receivedQueue = new ArrayBlockingQueue<>(5);

        session.subscribe("/topic/robots", new StompFrameHandler() {
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

    @Test
    @DisplayName("STOMP - 듀얼 영상 프레임이 /topic/video/{robotId} 로 중계됨")
    void testStompVideoBroadcasting() throws Exception {
        String stompUrl = "ws://localhost:" + port + "/ws/control";
        StompSession session = connect(stompUrl);

        BlockingQueue<String> receivedQueue = new ArrayBlockingQueue<>(5);

        session.subscribe("/topic/video/orinka_video_test", new StompFrameHandler() {
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

        Thread.sleep(500);

        RobotPacket packet = new RobotPacket();
        packet.setSource("robot");
        packet.setType("VIDEO_FRAME");
        packet.setRobotId("orinka_video_test");
        packet.setChannel("THERMAL");
        packet.setFormat("jpeg");
        packet.setData("BASE64_JPEG_DATA");
        packet.setMaxTemp(36.1);
        packet.setSeq(1024L);

        eventPublisher.publishEvent(new RobotVideoEvent(this, packet));

        String broadcasted = receivedQueue.poll(5, TimeUnit.SECONDS);
        assertThat(broadcasted).isNotNull();
        assertThat(broadcasted).contains("THERMAL");
        assertThat(broadcasted).contains("BASE64_JPEG_DATA");

        session.disconnect();
    }

    @Test
    @DisplayName("STOMP - 화재 확정 경보가 /topic/alerts 표준 페이로드로 발행됨")
    void testStompFireAlertBroadcasting() throws Exception {
        String stompUrl = "ws://localhost:" + port + "/ws/control";
        StompSession session = connect(stompUrl);

        BlockingQueue<String> receivedQueue = new ArrayBlockingQueue<>(5);

        session.subscribe("/topic/alerts", new StompFrameHandler() {
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

        Thread.sleep(500);

        RobotPacket packet = new RobotPacket();
        packet.setSource("robot");
        packet.setType("EVENT_FIRE");
        packet.setRobotId("orinka_alert_test");
        packet.setConfidence(0.94);
        packet.setTemperature(58.4);

        eventPublisher.publishEvent(new RobotFireEvent(this, packet));

        String broadcasted = receivedQueue.poll(5, TimeUnit.SECONDS);
        assertThat(broadcasted).isNotNull();
        assertThat(broadcasted).contains("\"type\":\"FIRE\"");
        assertThat(broadcasted).contains("\"source\":\"ROBOT\"");
        assertThat(broadcasted).contains("orinka_alert_test");

        session.disconnect();
    }
}
