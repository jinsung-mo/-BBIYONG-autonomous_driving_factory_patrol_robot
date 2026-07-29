package com.bbiyong.server.wss;

import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
@RequiredArgsConstructor
public class WebSocketConfig implements WebSocketConfigurer {

    // 로봇 VIDEO_FRAME(base64 JPEG)은 컨테이너 기본 텍스트 버퍼(8KB)를 넘어
    // "1009 message too big" 으로 /ws/robot 연결을 끊는다. 여유 있게 512KB 로 올린다.
    private static final int WS_BUFFER_BYTES = 512 * 1024;

    private final RobotWebSocketHandler robotWebSocketHandler;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(robotWebSocketHandler, "/ws/robot")
                .setAllowedOrigins("*");
    }

    /**
     * JSR-356 컨테이너의 메시지 버퍼 상한을 올린다. raw WebSocket 핸들러(/ws/robot)의
     * 인바운드 메시지 조립에 이 값이 적용되어, 로봇 영상 프레임 수신 시 1009 를 막는다.
     */
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(WS_BUFFER_BYTES);
        container.setMaxBinaryMessageBufferSize(WS_BUFFER_BYTES);
        return container;
    }
}
