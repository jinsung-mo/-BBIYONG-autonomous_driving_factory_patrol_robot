package com.bbiyong.server.stomp;

import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;

@Configuration
@EnableWebSocketMessageBroker
@RequiredArgsConstructor
public class StompWebSocketConfig implements WebSocketMessageBrokerConfigurer {

    // 로봇 영상(VIDEO_FRAME)을 /topic/video 로 브라우저에 중계할 때, STOMP 기본
    // 메시지 상한(64KB)·전송 버퍼를 넉넉히 올려 대용량 프레임이 잘리지 않게 한다.
    private static final int STOMP_MESSAGE_LIMIT = 512 * 1024;
    // 🔴 1MB -> 4MB. 이 값은 "한 프레임이 들어가는가"가 아니라 **느린 구독자가 몇 초를
    //    버티는가**를 정하는 값이다. 로봇이 MJPEG 패스스루(1920x1080@30)로 바뀌면서
    //    /topic/video 로 나가는 양이 초당 약 2.8MB(프레임 70KB + base64 33%)가 됐다.
    //    1MB 는 그 속도에서 **약 0.36초 치**다 — 브라우저가 탭 전환·GC·렌더 지연으로
    //    0.36초만 밀려도 세션별 송신 버퍼가 넘쳐 그 구독자의 연결이 끊긴다.
    //    4MB 면 약 1.4초를 버틴다. sendTimeLimit(20초)보다 이 값이 먼저 걸리므로
    //    영상 상시 송출에서 실제로 세션을 끊는 것은 거의 항상 이쪽이다.
    //    🔴 근본 해법은 아니다 — 버퍼를 키우는 것은 지연을 늘려 미루는 것이고, 제대로
    //    하려면 밀릴 때 프레임을 버리는 드랍 정책이 필요하다(SimpleBroker 에는 없다).
    //    영상 전용 연결 분리 + 바이너리 프레임이 정해지면 그때 함께 다룬다.
    private static final int STOMP_SEND_BUFFER = 4 * 1024 * 1024;

    private final StompAuthChannelInterceptor stompAuthChannelInterceptor;

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        // 클라이언트 -> 서버 인바운드 채널에 JWT 인증 인터셉터 등록 (CONNECT 시 검증)
        registration.interceptors(stompAuthChannelInterceptor);
    }

    @Override
    public void configureWebSocketTransport(WebSocketTransportRegistration registration) {
        // 서버 -> 브라우저(/topic/video) 영상 중계용 상한. setMessageSizeLimit 은 인바운드
        // STOMP 메시지 크기, setSendBufferSizeLimit 은 세션별 송신 버퍼 상한이다.
        registration.setMessageSizeLimit(STOMP_MESSAGE_LIMIT);
        registration.setSendBufferSizeLimit(STOMP_SEND_BUFFER);
        registration.setSendTimeLimit(20 * 1000);
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        // Topic prefixes for broadcasting to Web Observation Dashboard.
        // /queue 는 사용자 개인 목적지(/user/queue/control — 제어 거부 사유 통지)용으로만 쓴다.
        registry.enableSimpleBroker("/topic", "/queue");
        // Application prefix for incoming messages from Web Observation Dashboard
        registry.setApplicationDestinationPrefixes("/app");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        // Raw WebSocket endpoint for browser / mobile clients
        registry.addEndpoint("/ws-관제", "/ws/control")
                .setAllowedOriginPatterns("*");

        // SockJS fallback endpoint for web browser compatibility
        registry.addEndpoint("/ws-관제", "/ws/control")
                .setAllowedOriginPatterns("*")
                .withSockJS();
    }
}
