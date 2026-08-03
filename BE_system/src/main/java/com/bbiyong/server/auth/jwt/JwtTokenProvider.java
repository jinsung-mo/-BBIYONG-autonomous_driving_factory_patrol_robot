package com.bbiyong.server.auth.jwt;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jws;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;

/**
 * JWT 발급/검증 유틸 (HS256).
 *
 * <p>두 종류의 토큰을 발급한다.
 * <ul>
 *   <li><b>access</b> — 짧은 수명(기본 1h). API 인증에 사용. {@code role} 클레임 포함.</li>
 *   <li><b>refresh</b> — 긴 수명(기본 30d). access 재발급 전용. {@code typ=refresh} 클레임으로 구분.</li>
 * </ul>
 * 야간 무인 관제 운영을 위해 access 는 짧게 두되 refresh 로 무중단 갱신한다.
 */
@Component
public class JwtTokenProvider {

    /** 토큰 종류 구분 클레임 키. */
    public static final String CLAIM_TYPE = "typ";
    public static final String TYPE_ACCESS = "access";
    public static final String TYPE_REFRESH = "refresh";

    private final SecretKey key;
    private final long accessExpirationSeconds;
    private final long refreshExpirationSeconds;

    public JwtTokenProvider(
            @Value("${bbiyong.jwt.secret}") String secret,
            @Value("${bbiyong.jwt.access-expiration-seconds:3600}") long accessExpirationSeconds,
            @Value("${bbiyong.jwt.refresh-expiration-seconds:2592000}") long refreshExpirationSeconds) {
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.accessExpirationSeconds = accessExpirationSeconds;
        this.refreshExpirationSeconds = refreshExpirationSeconds;
    }

    /**
     * access 토큰 발급. (subject=email, role 클레임, typ=access)
     */
    public String generate(String email, String role) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(email)
                .claim("role", role)
                .claim(CLAIM_TYPE, TYPE_ACCESS)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(accessExpirationSeconds)))
                .signWith(key)
                .compact();
    }

    /**
     * refresh 토큰 발급. (subject=email, typ=refresh, role 미포함)
     */
    public String generateRefresh(String email) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(email)
                .claim(CLAIM_TYPE, TYPE_REFRESH)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(refreshExpirationSeconds)))
                .signWith(key)
                .compact();
    }

    public Jws<Claims> parse(String token) {
        return Jwts.parser().verifyWith(key).build().parseSignedClaims(token);
    }

    /** access 토큰 수명(초). 로그인 응답 {@code expiresIn} 노출용. */
    public long getAccessExpirationSeconds() {
        return accessExpirationSeconds;
    }

    public long getRefreshExpirationSeconds() {
        return refreshExpirationSeconds;
    }
}
