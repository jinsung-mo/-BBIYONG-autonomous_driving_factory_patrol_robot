package com.bbiyong.server.auth.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.authentication.WebAuthenticationDetailsSource;
import org.springframework.util.StringUtils;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.Set;

/**
 * 로봇/게이트웨이 업로드 인증 필터. (S15P11E101-517)
 *
 * <p>JWT가 없는 로봇/게이트웨이가 맵/영상을 올릴 수 있도록, <b>지정된 업로드 경로에 한해</b>
 * {@code X-Robot-Token} 헤더를 검증해 {@code ROLE_ROBOT} 로 인증한다. 업로드 외 경로에는
 * 관여하지 않아(경로 화이트리스트) 로봇 토큰이 광범위한 권한을 얻지 못한다.
 * 토큰이 미설정(blank)이면 아무 것도 하지 않아 기존처럼 JWT 필수로 남는다.
 */
public class RobotUploadTokenFilter extends OncePerRequestFilter {

    private static final String HEADER = "X-Robot-Token";
    private static final Set<String> UPLOAD_PATHS = Set.of("/api/maps/upload", "/api/videos/upload");

    private final String robotToken;

    public RobotUploadTokenFilter(String robotToken) {
        this.robotToken = robotToken;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (StringUtils.hasText(robotToken)
                && SecurityContextHolder.getContext().getAuthentication() == null
                && UPLOAD_PATHS.contains(request.getServletPath())) {
            String provided = request.getHeader(HEADER);
            if (provided != null && constantTimeEquals(provided, robotToken)) {
                UsernamePasswordAuthenticationToken auth = new UsernamePasswordAuthenticationToken(
                        "robot", null, List.of(new SimpleGrantedAuthority("ROLE_ROBOT")));
                auth.setDetails(new WebAuthenticationDetailsSource().buildDetails(request));
                SecurityContextHolder.getContext().setAuthentication(auth);
            }
        }
        chain.doFilter(request, response);
    }

    private boolean constantTimeEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }
}
