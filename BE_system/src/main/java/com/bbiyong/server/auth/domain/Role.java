package com.bbiyong.server.auth.domain;

/**
 * 사용자 권한(역할).
 *
 * <p>Spring Security 권한 문자열과 1:1로 매핑되도록 {@code ROLE_} 접두사를 이름에 포함한다.
 * (JWT {@code role} 클레임 · {@link org.springframework.security.core.authority.SimpleGrantedAuthority}
 * 값으로 {@link #name()} 을 그대로 사용)
 *
 * <ul>
 *   <li>{@link #ROLE_ADMIN} — 관제 관리자. 로봇 제어·설정 등 민감 작업 대상(추후 인가 게이팅).</li>
 *   <li>{@link #ROLE_USER} — 일반 사용자. 회원가입 시 부여되는 기본 권한.</li>
 * </ul>
 */
public enum Role {
    ROLE_ADMIN,
    ROLE_USER
}
