package com.bbiyong.server.auth.service;

import com.bbiyong.server.auth.domain.Role;
import com.bbiyong.server.auth.domain.User;
import com.bbiyong.server.auth.dto.FindIdRequest;
import com.bbiyong.server.auth.dto.FindIdResponse;
import com.bbiyong.server.auth.dto.LoginRequest;
import com.bbiyong.server.auth.dto.LoginResponse;
import com.bbiyong.server.auth.dto.RefreshResponse;
import com.bbiyong.server.auth.dto.ResetPasswordByPhoneRequest;
import com.bbiyong.server.auth.dto.ResetPasswordRequest;
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
import java.util.Optional;
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
    private final EmailVerificationService emailVerificationService;

    public AuthService(UserRepository userRepository,
                       PasswordEncoder passwordEncoder,
                       JwtTokenProvider jwtTokenProvider,
                       EmailVerificationService emailVerificationService) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtTokenProvider = jwtTokenProvider;
        this.emailVerificationService = emailVerificationService;
    }

    @Transactional
    public SignupResponse signup(SignupRequest request) {
        PasswordPolicy.validate(request.password());
        String gender = normalizeGender(request.gender());
        validateBirthDate(request.birthDate());

        // 이메일 소유 확인이 끝난 주소만 가입을 허용한다(send-code → verify-code 선행).
        emailVerificationService.requireVerified(
                EmailVerificationService.Purpose.SIGNUP, request.email());

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

        // 인증 상태는 1회용 — 가입 성공과 함께 소모한다.
        emailVerificationService.consumeVerified(
                EmailVerificationService.Purpose.SIGNUP, request.email());

        return new SignupResponse("SUCCESS", user.getEmail(), user.getName());
    }

    /**
     * 회원가입 이메일 인증코드를 발송한다. 이미 가입된 이메일이면 409 로 미리 알린다
     * (인증 절차를 끝까지 밟은 뒤 가입 단계에서야 중복을 알게 되는 헛수고를 막는다).
     */
    public void sendSignupCode(String email) {
        if (userRepository.existsByEmail(email)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "이미 존재하는 이메일입니다.");
        }
        emailVerificationService.sendCode(EmailVerificationService.Purpose.SIGNUP, email);
    }

    /** 회원가입 이메일 인증코드를 검증한다(성공 시 해당 이메일이 '인증됨'으로 표시된다). */
    public void verifySignupCode(String email, String code) {
        emailVerificationService.verifyCode(EmailVerificationService.Purpose.SIGNUP, email, code);
    }

    /**
     * 아이디(이메일) 찾기. 이름+생년월일로 후보를 좁히고 휴대전화번호는 숫자만 비교한다.
     * 매칭되는 계정이 없으면 404. 성공 시 이메일을 마스킹해 반환한다(개인정보 최소 노출).
     */
    @Transactional(readOnly = true)
    public FindIdResponse findEmail(FindIdRequest request) {
        User user = findByIdentity(request.name(), request.phoneNumber(), request.birthDate());
        return new FindIdResponse(maskEmail(user.getEmail()));
    }

    /**
     * 휴대전화 경로 비밀번호 재설정 — 1단계. 이름·휴대전화·생년월일로 계정을 찾아
     * <b>그 계정의 이메일</b>로 재설정 인증코드를 보내고, 어느 메일함을 열어야 하는지
     * 알 수 있도록 마스킹된 이메일을 돌려준다.
     *
     * <p>🔴 이메일 경로({@link #sendPasswordResetCode})와 달리 계정이 없으면 404 다.
     * 그쪽은 이메일 한 줄만 받으므로 무응답으로 계정 열거를 막을 수 있지만, 이쪽은
     * 마스킹 이메일을 돌려주지 않으면 사용자가 다음 단계로 갈 수 없다. 이미 같은 3종을
     * 받는 아이디 찾기(find-id)가 동일하게 404 를 내므로 노출 수준은 그대로다.
     */
    public FindIdResponse sendPasswordResetCodeByPhone(FindIdRequest request) {
        User user = findByIdentity(request.name(), request.phoneNumber(), request.birthDate());
        emailVerificationService.sendCode(
                EmailVerificationService.Purpose.PASSWORD_RESET, user.getEmail());
        return new FindIdResponse(maskEmail(user.getEmail()));
    }

    /**
     * 휴대전화 경로 비밀번호 재설정 — 2단계. 본인 확인 3종으로 계정을 다시 찾아
     * 그 이메일에 발급된 코드를 검증한다(코드 저장소는 이메일 경로와 공용).
     */
    @Transactional
    public void resetPasswordByPhone(ResetPasswordByPhoneRequest request) {
        // 이메일 경로와 같은 순서 — 정책 검증을 먼저 해서 약한 비밀번호 때문에
        // 1회용 코드가 소모되는 헛수고를 막는다.
        PasswordPolicy.validate(request.newPassword());
        User user = findByIdentity(request.name(), request.phoneNumber(), request.birthDate());
        emailVerificationService.verifyCode(
                EmailVerificationService.Purpose.PASSWORD_RESET, user.getEmail(), request.code());

        user.setPasswordHash(passwordEncoder.encode(request.newPassword()));
        userRepository.save(user);
        emailVerificationService.consumeVerified(
                EmailVerificationService.Purpose.PASSWORD_RESET, user.getEmail());
    }

    /**
     * 이름·휴대전화·생년월일이 모두 일치하는 계정 하나를 찾는다.
     * 휴대전화는 저장 형식(하이픈 유무)이 계정마다 다를 수 있어 숫자만 비교한다.
     */
    private User findByIdentity(String name, String phoneNumber, LocalDate birthDate) {
        String inputDigits = digitsOnly(phoneNumber);
        Optional<User> match = userRepository
                .findByNameAndBirthDate(name.trim(), birthDate).stream()
                .filter(u -> digitsOnly(u.getPhoneNumber()).equals(inputDigits))
                .findFirst();
        return match.orElseThrow(() -> new ResponseStatusException(
                HttpStatus.NOT_FOUND, "일치하는 계정을 찾을 수 없습니다. 입력한 정보를 확인하세요."));
    }

    /**
     * 비밀번호 재설정 인증코드를 발송한다. 가입되지 않은 이메일이면 코드를 보내지 않되,
     * 계정 존재 여부가 드러나지 않도록 예외 없이 동일하게 처리한다(계정 열거 방지).
     */
    public void sendPasswordResetCode(String email) {
        if (userRepository.findByEmail(email).isPresent()) {
            emailVerificationService.sendCode(EmailVerificationService.Purpose.PASSWORD_RESET, email);
        }
    }

    /**
     * 비밀번호를 재설정한다. 인증코드 검증 → 새 비밀번호 정책 검증 → 해시 교체 순서로 처리한다.
     * 코드가 유효하면 send 단계에서 계정이 존재했음이 보장되지만, 그 사이 삭제됐을 수 있어 재확인한다.
     */
    @Transactional
    public void resetPassword(ResetPasswordRequest request) {
        // 새 비밀번호 정책을 먼저 본다 — 약한 비밀번호 때문에 유효한 코드가 소모(1회용)되면
        // 사용자가 코드를 다시 받아야 하는 헛수고가 생긴다. 코드 검증은 그 뒤에 한다.
        PasswordPolicy.validate(request.newPassword());
        emailVerificationService.verifyCode(
                EmailVerificationService.Purpose.PASSWORD_RESET, request.email(), request.code());

        User user = userRepository.findByEmail(request.email())
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "일치하는 계정을 찾을 수 없습니다."));
        user.setPasswordHash(passwordEncoder.encode(request.newPassword()));
        userRepository.save(user);
        emailVerificationService.consumeVerified(
                EmailVerificationService.Purpose.PASSWORD_RESET, request.email());
    }

    private static String digitsOnly(String value) {
        return value == null ? "" : value.replaceAll("\\D", "");
    }

    /** 이메일 로컬파트 앞 2자만 남기고 마스킹한다(1자면 1자만). 예: kim.test@x.com → ki***@x.com */
    private static String maskEmail(String email) {
        int at = email.indexOf('@');
        if (at <= 0) {
            return "***";
        }
        String local = email.substring(0, at);
        String domain = email.substring(at);
        int keep = local.length() <= 2 ? 1 : 2;
        return local.substring(0, keep) + "***" + domain;
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
