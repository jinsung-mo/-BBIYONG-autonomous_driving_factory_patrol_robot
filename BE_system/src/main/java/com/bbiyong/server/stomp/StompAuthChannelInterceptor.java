package com.bbiyong.server.stomp;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jws;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.MessagingException;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * STOMP 클라이언트 인바운드 채널 인터셉터.
 *
 * <p>CONNECT 프레임의 {@code Authorization: Bearer <JWT>} 헤더를 검증하여
 * 유효하면 인증 Principal 을 세션에 부여하고, 없거나 무효면 연결을 거부한다.
 * REST(/api/**)의 JWT 인가와 동일한 보안 레벨을 실시간 계층(/ws/control)에도 적용한다.
 *
 * <p>로봇 원시 WSS(/ws/robot)는 STOMP 가 아닌 별도 {@code TextWebSocketHandler} 채널이므로
 * 본 인터셉터의 대상이 아니다.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class StompAuthChannelInterceptor implements ChannelInterceptor {

    private static final String BEARER_PREFIX = "Bearer ";

    private final JwtTokenProvider jwtTokenProvider;

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null) {
            return message;
        }
        // SUBSCRIBE 목적지 화이트리스트: 브로드캐스트는 /topic/** 만 사용한다.
        // /queue, /user 등 미사용 목적지 구독을 차단해 브로커 오남용을 막는다. (S15P11E101-729)
        if (StompCommand.SUBSCRIBE.equals(accessor.getCommand())) {
            String destination = accessor.getDestination();
            if (destination == null || !destination.startsWith("/topic/")) {
                log.debug("STOMP SUBSCRIBE 거부: 허용되지 않은 목적지 {}", destination);
                throw new MessagingException("허용되지 않은 구독 목적지입니다: " + destination);
            }
            return message;
        }
        if (!StompCommand.CONNECT.equals(accessor.getCommand())) {
            return message;
        }

        String token = resolveToken(accessor.getFirstNativeHeader("Authorization"));
        if (token == null) {
            log.debug("STOMP CONNECT 거부: 인증 토큰 없음");
            throw new MessagingException("인증 토큰이 없어 STOMP 연결이 거부되었습니다.");
        }
        try {
            Jws<Claims> jws = jwtTokenProvider.parse(token);
            Claims claims = jws.getPayload();
            String email = claims.getSubject();
            String role = claims.get("role", String.class);
            List<SimpleGrantedAuthority> authorities = role != null
                    ? List.of(new SimpleGrantedAuthority(role))
                    : List.of();
            UsernamePasswordAuthenticationToken authentication =
                    new UsernamePasswordAuthenticationToken(email, null, authorities);
            accessor.setUser(authentication);
            log.debug("STOMP CONNECT 인증 성공: {}", email);
        } catch (JwtException | IllegalArgumentException ex) {
            log.debug("STOMP CONNECT 거부: JWT 검증 실패 - {}", ex.getMessage());
            throw new MessagingException("유효하지 않은 인증 토큰입니다.");
        }
        return message;
    }

    private String resolveToken(String header) {
        if (header != null && header.startsWith(BEARER_PREFIX)) {
            return header.substring(BEARER_PREFIX.length()).trim();
        }
        return null;
    }
}
