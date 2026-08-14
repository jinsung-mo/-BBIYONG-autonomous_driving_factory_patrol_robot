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

    // 인바운드 STOMP 메시지 상한. 기본값 64KB 로는 지도(RLE)·열화상이 잘릴 수 있어 올려 둔다.
    // 남은 트래픽 기준으로는 넉넉하지만, 잘림은 조용히 깨지는 실패라 여유를 남긴다.
    private static final int STOMP_MESSAGE_LIMIT = 512 * 1024;
    // 🔴 4MB -> 512KB. 이 값은 "한 메시지가 들어가는가"가 아니라 **느린 구독자가 몇 초를
    //    버티는가**를 정하고, 그 시간만큼 **낡은 데이터가 쌓인다**는 뜻이기도 하다.
    //
    //    왜 4MB 였나: 로봇이 MJPEG 패스스루로 바뀌며 /topic/video 로 초당 수 MB 가 나갔고,
    //    1MB 는 그 속도에서 약 0.36초 치라 브라우저가 잠깐만 밀려도 세션이 끊겼다
    //    (실측 "exceeds the allowed limit" 3시간 20회 → 5분 7회). 그래서 올렸다.
    //
    //    왜 이제 줄이나: 2026-08-12 에 영상이 STOMP 를 **떠났다**. 로봇이
    //    `ORINCAR_VIDEO_TRANSPORT=off` 로 전환하고 FRONT 카메라는 HLS(nginx 정적)로 나간다
    //    — 적용 확인됨(`[bridge] transport=off`, Orin TX 12.3 → 8.2 Mbps).
    //    /topic 에 남은 것은 텔레메트리(2Hz, ~1KB) · 지도(RLE 197x185, 1Hz) ·
    //    열화상(32x24 PNG, 저빈도) 뿐이고 합쳐서 초당 수십 KB 수준이다.
    //    그 트래픽에 4MB 는 **1초 넘는 낡은 데이터를 쌓아두는 부작용만** 남는다 —
    //    조작자가 몇 초 전 지도와 온도를 지금 값으로 읽게 된다.
    //    512KB 면 남은 트래픽 기준으로도 수십 초 여유라 정상 지연을 끊지 않으면서
    //    적체 상한을 8배 낮춘다.
    //
    //    🔴 순서가 중요했다 — 영상이 STOMP 를 떠나기 **전에** 줄이면 세션이 더 자주 죽는다.
    //    transport=off 적용을 확인한 뒤에 줄이는 것이 이 변경의 전제다.
    private static final int STOMP_SEND_BUFFER = 512 * 1024;

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
