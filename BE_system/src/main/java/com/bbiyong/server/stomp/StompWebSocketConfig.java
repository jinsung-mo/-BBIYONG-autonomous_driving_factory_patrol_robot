package com.bbiyong.server.stomp;

import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

@Configuration
@EnableWebSocketMessageBroker
@RequiredArgsConstructor
public class StompWebSocketConfig implements WebSocketMessageBrokerConfigurer {

    private final StompAuthChannelInterceptor stompAuthChannelInterceptor;

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        // 클라이언트 -> 서버 인바운드 채널에 JWT 인증 인터셉터 등록 (CONNECT 시 검증)
        registration.interceptors(stompAuthChannelInterceptor);
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        // Topic prefixes for broadcasting to Web Observation Dashboard
        registry.enableSimpleBroker("/topic");
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
