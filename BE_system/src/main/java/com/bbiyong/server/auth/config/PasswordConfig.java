package com.bbiyong.server.auth.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * 비밀번호 해시용 BCrypt 인코더 빈.
 * spring-boot-starter-security(전체 필터 체인) 대신 spring-security-crypto 만 사용하여
 * 엔드포인트는 열어둔 채(인가 필터는 후속) 비밀번호 해시만 도입한다.
 */
@Configuration
public class PasswordConfig {

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }
}
