package com.bbiyong.server.auth.security;

import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

/**
 * REST 인증/인가 필터 체인.
 *
 * <p>정책(MVP):
 * <ul>
 *   <li>세션 미사용(STATELESS) — JWT 기반 무상태 인증</li>
 *   <li>공개: 인증 API(/api/auth/**), actuator, 실시간 소켓 핸드셰이크(WSS/STOMP)</li>
 *   <li>그 외 /api/** 는 유효한 JWT 필요</li>
 *   <li>401/403 은 GlobalExceptionHandler 와 동일한 통일 에러 포맷으로 응답</li>
 * </ul>
 */
@Configuration
@EnableWebSecurity
@RequiredArgsConstructor
public class SecurityConfig {

    private final JwtTokenProvider jwtTokenProvider;
    private final RestAuthenticationEntryPoint authenticationEntryPoint;
    private final RestAccessDeniedHandler accessDeniedHandler;

    @Bean
    public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                .httpBasic(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth
                        // CORS 프리플라이트
                        .requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                        // 인증 API (회원가입/로그인)
                        .requestMatchers("/api/auth/**").permitAll()
                        // 헬스/모니터링
                        .requestMatchers("/actuator/**").permitAll()
                        // 실시간 소켓 핸드셰이크 (로봇 WSS · 관제 STOMP/SockJS)
                        .requestMatchers("/ws/robot/**", "/ws-관제/**", "/ws/control/**").permitAll()
                        // 그 외 REST 는 인증 필요
                        .anyRequest().authenticated())
                .exceptionHandling(ex -> ex
                        .authenticationEntryPoint(authenticationEntryPoint)
                        .accessDeniedHandler(accessDeniedHandler))
                .addFilterBefore(new JwtAuthenticationFilter(jwtTokenProvider),
                        UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }
}
