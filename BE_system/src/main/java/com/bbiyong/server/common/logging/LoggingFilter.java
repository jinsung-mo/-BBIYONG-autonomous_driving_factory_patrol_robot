package com.bbiyong.server.common.logging;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * HTTP 요청마다 구조화된 로깅 컨텍스트를 자동으로 설정하는 필터
 *
 * <p>다음 정보를 MDC에 자동 설정:</p>
 * <ul>
 *   <li>requestId: 요청별 고유 ID (추적용)</li>
 *   <li>userId: 인증된 사용자 ID</li>
 *   <li>clientIp: 클라이언트 IP 주소</li>
 * </ul>
 *
 * <p>요청 처리 시간과 상태 코드도 로그에 기록됩니다.</p>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class LoggingFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(LoggingFilter.class);

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {

        long startTime = System.currentTimeMillis();

        try {
            // 요청 ID 생성 및 설정
            String requestId = LoggingContext.generateAndSetRequestId();

            // 클라이언트 IP 설정
            String clientIp = getClientIp(request);
            LoggingContext.setClientIp(clientIp);

            // 요청 시작 로그
            log.info("HTTP Request started: {} {} from {}",
                    request.getMethod(),
                    request.getRequestURI(),
                    clientIp);

            // 다음 필터 실행
            filterChain.doFilter(request, response);

        } finally {
            // 인증 정보가 있으면 사용자 ID 설정 (Security 필터 이후)
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            if (authentication != null && authentication.isAuthenticated()
                    && !"anonymousUser".equals(authentication.getPrincipal())) {
                LoggingContext.setUserId(authentication.getName());
            }

            // 요청 완료 로그
            long duration = System.currentTimeMillis() - startTime;
            log.info("HTTP Request completed: {} {} - Status: {} - Duration: {}ms",
                    request.getMethod(),
                    request.getRequestURI(),
                    response.getStatus(),
                    duration);

            // MDC 정리 (메모리 누수 방지)
            LoggingContext.clear();
        }
    }

    /**
     * X-Forwarded-For 헤더를 고려하여 실제 클라이언트 IP를 추출
     */
    private String getClientIp(HttpServletRequest request) {
        String ip = request.getHeader("X-Forwarded-For");
        if (ip == null || ip.isEmpty() || "unknown".equalsIgnoreCase(ip)) {
            ip = request.getHeader("X-Real-IP");
        }
        if (ip == null || ip.isEmpty() || "unknown".equalsIgnoreCase(ip)) {
            ip = request.getRemoteAddr();
        }

        // X-Forwarded-For에 여러 IP가 있는 경우 첫 번째가 실제 클라이언트 IP
        if (ip != null && ip.contains(",")) {
            ip = ip.split(",")[0].trim();
        }

        return ip;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // Actuator health check는 로깅 스킵 (불필요한 로그 방지)
        String path = request.getRequestURI();
        return path.startsWith("/actuator/health");
    }
}
