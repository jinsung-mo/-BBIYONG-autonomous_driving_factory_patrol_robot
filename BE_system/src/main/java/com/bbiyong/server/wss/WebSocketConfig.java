package com.bbiyong.server.wss;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.tomcat.servlet.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    // 로봇 VIDEO_FRAME(base64 JPEG)·MAP(RLE)은 컨테이너 기본 텍스트 버퍼(8KB)를 넘어
    // "1009 message too big" 으로 /ws/robot 연결을 끊는다. 여유 있게 512KB 로 올린다.
    private static final int WS_BUFFER_BYTES = 512 * 1024;

    private final RobotWebSocketHandler robotWebSocketHandler;

    /** 로봇 핸드셰이크 인증용 공유 토큰(업로드 필터와 동일 시크릿). 비면 인증 비활성. */
    private final String robotToken;

    public WebSocketConfig(RobotWebSocketHandler robotWebSocketHandler,
                           @Value("${bbiyong.robot.upload-token:}") String robotToken) {
        this.robotWebSocketHandler = robotWebSocketHandler;
        this.robotToken = robotToken;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(robotWebSocketHandler, "/ws/robot")
                .addInterceptors(new RobotHandshakeAuthInterceptor(robotToken))
                .setAllowedOrigins("*");
    }

    /**
     * 내장 Tomcat 의 WebSocket 텍스트/바이너리 버퍼 상한을 Tomcat 컨텍스트 파라미터로 올린다.
     *
     * <p>{@code ServletServerContainerFactoryBean} 대신 {@code WebServerFactoryCustomizer}
     * 를 쓰는 이유: 후자는 실제 내장 서버가 만들어질 때만 적용되므로, 실 컨테이너가 없는
     * MOCK 웹 환경 테스트(@SpringBootTest 기본)의 컨텍스트 로딩을 깨지 않는다.
     * (ServletServerContainerFactoryBean 은 MOCK 에서 ServerContainer 를 못 찾아
     * 빈 생성 시 IllegalStateException 을 던져 전 테스트의 contextLoads 를 실패시킨다.)
     */
    @Bean
    public WebServerFactoryCustomizer<TomcatServletWebServerFactory> webSocketBufferCustomizer() {
        return factory -> factory.addContextCustomizers(context -> {
            context.addParameter(
                    "org.apache.tomcat.websocket.textBufferSize", String.valueOf(WS_BUFFER_BYTES));
            context.addParameter(
                    "org.apache.tomcat.websocket.binaryBufferSize", String.valueOf(WS_BUFFER_BYTES));
        });
    }
}
