package com.bbiyong.server.auth.config;

import com.bbiyong.server.auth.domain.Role;
import com.bbiyong.server.auth.domain.User;
import com.bbiyong.server.auth.repository.UserRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.CommandLineRunner;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.Instant;

/**
 * 최초 관리자 계정 부트스트랩.
 *
 * <p>회원가입 기본 권한이 {@code ROLE_USER} 로 바뀌면서, 신규 배포 환경에는 관리자가
 * 한 명도 없어 승격을 시작할 수 없는 부트스트랩 문제가 생긴다. 이를 위해 프로퍼티로
 * 지정한 계정을 기동 시 관리자(create-or-promote)로 보장한다.
 *
 * <ul>
 *   <li>{@code bbiyong.admin.email} 미설정 시 아무 동작도 하지 않는다(운영 안전 기본값).</li>
 *   <li>계정이 없으면 생성(비밀번호는 {@code bbiyong.admin.password} 필요).</li>
 *   <li>계정이 있으면 {@code ROLE_ADMIN} 으로 승격만 한다(비밀번호는 건드리지 않음).</li>
 * </ul>
 */
@Slf4j
@Component
public class AdminSeeder implements CommandLineRunner {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final String adminEmail;
    private final String adminPassword;
    private final String adminName;

    public AdminSeeder(UserRepository userRepository,
                       PasswordEncoder passwordEncoder,
                       @Value("${bbiyong.admin.email:}") String adminEmail,
                       @Value("${bbiyong.admin.password:}") String adminPassword,
                       @Value("${bbiyong.admin.name:관제 관리자}") String adminName) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.adminEmail = adminEmail;
        this.adminPassword = adminPassword;
        this.adminName = adminName;
    }

    @Override
    @Transactional
    public void run(String... args) {
        if (!StringUtils.hasText(adminEmail)) {
            return; // 시드 미설정: 아무 동작 안 함
        }

        userRepository.findByEmail(adminEmail).ifPresentOrElse(existing -> {
            if (existing.getRole() != Role.ROLE_ADMIN) {
                existing.setRole(Role.ROLE_ADMIN);
                userRepository.save(existing);
                log.info("관리자 시드: 기존 계정 {} 을(를) ROLE_ADMIN 으로 승격", adminEmail);
            }
        }, () -> {
            if (!StringUtils.hasText(adminPassword)) {
                log.warn("관리자 시드 계정({})이 없지만 bbiyong.admin.password 가 없어 생성을 건너뜀", adminEmail);
                return;
            }
            User admin = new User();
            admin.setEmail(adminEmail);
            admin.setPasswordHash(passwordEncoder.encode(adminPassword));
            admin.setName(adminName);
            admin.setRole(Role.ROLE_ADMIN);
            admin.setCreatedAt(Instant.now());
            userRepository.save(admin);
            log.info("관리자 시드: 신규 관리자 계정 {} 생성", adminEmail);
        });
    }
}
