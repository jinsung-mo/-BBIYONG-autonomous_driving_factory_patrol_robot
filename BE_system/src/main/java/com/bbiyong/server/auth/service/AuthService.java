package com.bbiyong.server.auth.service;

import com.bbiyong.server.auth.domain.User;
import com.bbiyong.server.auth.dto.LoginRequest;
import com.bbiyong.server.auth.dto.LoginResponse;
import com.bbiyong.server.auth.dto.SignupRequest;
import com.bbiyong.server.auth.dto.SignupResponse;
import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import com.bbiyong.server.auth.repository.UserRepository;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;

@Service
public class AuthService {

    private static final String DEFAULT_ROLE = "ROLE_ADMIN";

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtTokenProvider jwtTokenProvider;

    public AuthService(UserRepository userRepository,
                       PasswordEncoder passwordEncoder,
                       JwtTokenProvider jwtTokenProvider) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtTokenProvider = jwtTokenProvider;
    }

    @Transactional
    public SignupResponse signup(SignupRequest request) {
        if (userRepository.existsByEmail(request.email())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "이미 존재하는 이메일입니다.");
        }

        User user = new User();
        user.setEmail(request.email());
        user.setPasswordHash(passwordEncoder.encode(request.password()));
        user.setName(request.name());
        user.setRole(DEFAULT_ROLE);
        user.setCreatedAt(Instant.now());
        userRepository.save(user);

        return new SignupResponse("SUCCESS", user.getEmail(), user.getName());
    }

    @Transactional(readOnly = true)
    public LoginResponse login(LoginRequest request) {
        User user = userRepository.findByEmail(request.email())
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.UNAUTHORIZED, "이메일 또는 비밀번호가 올바르지 않습니다."));

        if (!passwordEncoder.matches(request.password(), user.getPasswordHash())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "이메일 또는 비밀번호가 올바르지 않습니다.");
        }

        String accessToken = jwtTokenProvider.generate(user.getEmail(), user.getRole());
        return new LoginResponse("Bearer", accessToken, jwtTokenProvider.getExpirationSeconds(), user.getRole());
    }
}
