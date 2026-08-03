package com.bbiyong.server.auth.service;

import com.bbiyong.server.auth.domain.Role;
import com.bbiyong.server.auth.domain.User;
import com.bbiyong.server.auth.dto.LoginRequest;
import com.bbiyong.server.auth.dto.LoginResponse;
import com.bbiyong.server.auth.dto.RefreshResponse;
import com.bbiyong.server.auth.dto.SignupRequest;
import com.bbiyong.server.auth.dto.SignupResponse;
import com.bbiyong.server.auth.jwt.JwtTokenProvider;
import com.bbiyong.server.auth.repository.UserRepository;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jws;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

@Service
public class AuthService {

    /** 회원가입 시 부여되는 기본 권한. 관리자 승격은 별도(관리 API / 시드)로만 이뤄진다. */
    private static final Role DEFAULT_ROLE = Role.ROLE_USER;
    private static final Set<String> ALLOWED_GENDERS = Set.of("MALE", "FEMALE", "NONE");
    private static final LocalDate MIN_BIRTH_DATE = LocalDate.of(1900, 1, 1);

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
        validatePassword(request.password());
        String gender = normalizeGender(request.gender());
        validateBirthDate(request.birthDate());

        if (userRepository.existsByEmail(request.email())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "이미 존재하는 이메일입니다.");
        }

        User user = new User();
        user.setEmail(request.email());
        user.setPasswordHash(passwordEncoder.encode(request.password()));
        user.setName(request.name());
        user.setPhoneNumber(request.phoneNumber());
        user.setBirthDate(request.birthDate());
        user.setGender(gender);
        user.setRole(DEFAULT_ROLE);
        user.setCreatedAt(Instant.now());
        userRepository.save(user);

        return new SignupResponse("SUCCESS", user.getEmail(), user.getName());
    }

    /**
     * 비밀번호 정책: 8자 이상 + 영문·숫자·특수문자 각 1자 이상.
     * 미충족 시 부족한 항목을 구체적으로 안내한다.
     */
    private void validatePassword(String password) {
        List<String> missing = new ArrayList<>();
        if (password.length() < 8) {
            missing.add("8자 이상");
        }
        if (!password.matches(".*[A-Za-z].*")) {
            missing.add("영문");
        }
        if (!password.matches(".*\\d.*")) {
            missing.add("숫자");
        }
        if (!password.matches(".*[^A-Za-z0-9\\s].*")) {
            missing.add("특수문자");
        }
        if (!missing.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "비밀번호에 다음을 포함하세요: " + String.join(", ", missing));
        }
    }

    private String normalizeGender(String gender) {
        String normalized = gender.trim().toUpperCase();
        if (!ALLOWED_GENDERS.contains(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "성별은 MALE, FEMALE, NONE 중 하나여야 합니다.");
        }
        return normalized;
    }

    private void validateBirthDate(LocalDate birthDate) {
        if (birthDate.isAfter(LocalDate.now())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "생년월일은 미래일 수 없습니다.");
        }
        if (birthDate.isBefore(MIN_BIRTH_DATE)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "생년월일 연도가 올바르지 않습니다.");
        }
    }

    @Transactional(readOnly = true)
    public LoginResponse login(LoginRequest request) {
        User user = userRepository.findByEmail(request.email())
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.UNAUTHORIZED, "이메일 또는 비밀번호가 올바르지 않습니다."));

        if (!passwordEncoder.matches(request.password(), user.getPasswordHash())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "이메일 또는 비밀번호가 올바르지 않습니다.");
        }

        String role = user.getRole().name();
        String accessToken = jwtTokenProvider.generate(user.getEmail(), role);
        String refreshToken = jwtTokenProvider.generateRefresh(user.getEmail());
        return new LoginResponse("Bearer", accessToken, refreshToken,
                jwtTokenProvider.getAccessExpirationSeconds(), role);
    }

    /**
     * refresh 토큰으로 access 토큰을 재발급한다. refresh 토큰도 함께 회전(rotate)하여
     * 활동 중에는 세션이 만료되지 않도록 한다(야간 무인 관제 대응).
     *
     * <p>실패 시 401: 서명/형식 오류·만료, typ 불일치, 삭제된 사용자.
     */
    @Transactional(readOnly = true)
    public RefreshResponse refresh(String refreshToken) {
        final Claims claims;
        try {
            Jws<Claims> jws = jwtTokenProvider.parse(refreshToken);
            claims = jws.getPayload();
        } catch (JwtException | IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "유효하지 않은 refresh 토큰입니다.");
        }

        String type = claims.get(JwtTokenProvider.CLAIM_TYPE, String.class);
        if (!JwtTokenProvider.TYPE_REFRESH.equals(type)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "refresh 토큰이 아닙니다.");
        }

        String email = claims.getSubject();
        User user = userRepository.findByEmail(email)
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.UNAUTHORIZED, "존재하지 않는 사용자입니다."));

        String role = user.getRole().name();
        String newAccess = jwtTokenProvider.generate(user.getEmail(), role);
        String newRefresh = jwtTokenProvider.generateRefresh(user.getEmail());
        return new RefreshResponse("Bearer", newAccess, newRefresh,
                jwtTokenProvider.getAccessExpirationSeconds(), role);
    }
}
