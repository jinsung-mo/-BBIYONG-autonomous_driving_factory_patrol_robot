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
    private static final int STOMP_SEND_BUFFER = 1024 * 1024;

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
