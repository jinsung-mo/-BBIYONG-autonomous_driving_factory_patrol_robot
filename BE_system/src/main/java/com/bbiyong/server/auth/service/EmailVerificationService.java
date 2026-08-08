package com.bbiyong.server.auth.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.mail.MailException;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import jakarta.mail.MessagingException;
import jakarta.mail.internet.MimeMessage;

import java.security.SecureRandom;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 이메일 인증코드 발송·검증(S15P11E101 회원 인증/복구).
 *
 * <p>저장소는 인메모리({@link ConcurrentHashMap})다 — Redis 미도입 상태의 MVP.
 * TTL 은 항목마다 만료 시각을 두고 접근 시점에 지연 만료(lazy expiry)한다. 단일 인스턴스 전제.
 *
 * <p>용도({@link Purpose})별로 코드/인증 상태를 분리한다:
 * <ul>
 *   <li>{@link Purpose#SIGNUP} — 회원가입 이메일 소유 확인</li>
 *   <li>{@link Purpose#PASSWORD_RESET} — 비밀번호 재설정 본인 확인</li>
 * </ul>
 *
 * <p>SMTP 자격증명(spring.mail.username)이 비어 있으면 개발모드로 동작해 실제 발송 대신
 * 코드를 서버 로그에 출력한다. 로컬 개발/데모에서 메일 계정 없이도 흐름을 확인할 수 있다.
 */
@Service
public class EmailVerificationService {

    public enum Purpose { SIGNUP, PASSWORD_RESET }

    private static final Logger log = LoggerFactory.getLogger(EmailVerificationService.class);
    private static final SecureRandom RANDOM = new SecureRandom();

    /** 발급된 코드. key = purpose:email(정규화). */
    private final ConcurrentHashMap<String, CodeEntry> codes = new ConcurrentHashMap<>();
    /** 검증 성공한 이메일. key = purpose:email(정규화), value = 인증 만료 epoch millis. */
    private final ConcurrentHashMap<String, Long> verified = new ConcurrentHashMap<>();

    private final JavaMailSender mailSender;
    private final boolean devMode;
    private final String from;
    private final long codeTtlMs;
    private final long verifiedTtlMs;
    private final int maxAttempts;

    public EmailVerificationService(
            JavaMailSender mailSender,
            @Value("${spring.mail.username:}") String mailUsername,
            @Value("${bbiyong.mail.from:삐용 관제 <no-reply@bbiyong.io>}") String from,
            @Value("${bbiyong.mail.code-ttl-seconds:300}") long codeTtlSeconds,
            @Value("${bbiyong.mail.verified-ttl-seconds:1800}") long verifiedTtlSeconds,
            @Value("${bbiyong.mail.max-verify-attempts:5}") int maxAttempts) {
        this.mailSender = mailSender;
        this.devMode = mailUsername == null || mailUsername.isBlank();
        this.from = from;
        this.codeTtlMs = codeTtlSeconds * 1000L;
        this.verifiedTtlMs = verifiedTtlSeconds * 1000L;
        this.maxAttempts = maxAttempts;
        if (devMode) {
            log.warn("[EmailVerification] SMTP 자격증명 미설정 — 개발모드로 동작합니다. "
                    + "인증코드는 실제 발송되지 않고 서버 로그에 출력됩니다. "
                    + "실제 발송하려면 BBIYONG_MAIL_USERNAME/PASSWORD 를 주입하세요.");
        }
    }

    /**
     * 인증코드를 발급하고 발송한다. 같은 이메일로 재요청하면 이전 코드는 무효화(덮어쓰기)된다.
     */
    public void sendCode(Purpose purpose, String email) {
        prune();
        String key = key(purpose, email);
        String code = generateCode();
        codes.put(key, new CodeEntry(code, System.currentTimeMillis() + codeTtlMs));
        deliver(purpose, email, code);
    }

    /**
     * 코드를 검증한다. 성공 시 해당 이메일을 '인증됨' 상태로 표시하고 코드는 소모한다.
     * 실패 사유별로 400/410/429 를 던진다.
     */
    public void verifyCode(Purpose purpose, String email, String code) {
        String key = key(purpose, email);
        CodeEntry entry = codes.get(key);
        if (entry == null || entry.isExpired()) {
            codes.remove(key);
            throw new ResponseStatusException(HttpStatus.GONE,
                    "인증코드가 만료되었거나 발급되지 않았습니다. 코드를 다시 요청하세요.");
        }
        if (entry.attempts.incrementAndGet() > maxAttempts) {
            codes.remove(key);
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "인증 시도 횟수를 초과했습니다. 코드를 다시 요청하세요.");
        }
        if (!entry.code.equals(code == null ? null : code.trim())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "인증코드가 올바르지 않습니다.");
        }
        codes.remove(key);
        verified.put(key, System.currentTimeMillis() + verifiedTtlMs);
    }

    /** 인증 완료 여부(만료 전). */
    public boolean isVerified(Purpose purpose, String email) {
        Long until = verified.get(key(purpose, email));
        return until != null && until > System.currentTimeMillis();
    }

    /** 인증 완료를 요구한다. 아니면 400. 회원가입/재설정의 마지막 단계에서 호출한다. */
    public void requireVerified(Purpose purpose, String email) {
        if (!isVerified(purpose, email)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "이메일 인증이 완료되지 않았습니다. 인증을 먼저 진행하세요.");
        }
    }

    /** 인증 상태를 소모(1회용)한다. 회원가입/재설정 성공 직후 호출한다. */
    public void consumeVerified(Purpose purpose, String email) {
        verified.remove(key(purpose, email));
    }

    // ---- 내부 구현 ----

    private void deliver(Purpose purpose, String email, String code) {
        long minutes = codeTtlMs / 60_000L;
        String subject = purpose == Purpose.PASSWORD_RESET
                ? "[삐용 관제] 비밀번호 재설정 인증코드"
                : "[삐용 관제] 이메일 인증코드";
        String body = "인증코드: " + code + "\n\n"
                + "이 코드를 인증코드 입력란에 입력하세요.\n"
                + "코드는 " + minutes + "분간 유효합니다.\n"
                + "본인이 요청하지 않았다면 이 메일을 무시하세요.";

        if (devMode) {
            log.info("[EmailVerification][DEV] to={} purpose={} code={} (실제 발송 안 함)",
                    email, purpose, code);
            return;
        }
        try {
            MimeMessage mimeMessage = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mimeMessage, "utf-8");
            helper.setFrom(from);
            helper.setTo(email);
            helper.setSubject(subject);
            helper.setText(body, false);
            mailSender.send(mimeMessage);
        } catch (MessagingException | MailException ex) {
            log.error("[EmailVerification] 메일 발송 실패 to={} purpose={}", email, purpose, ex);
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,
                    "인증 메일 발송에 실패했습니다. 잠시 후 다시 시도하세요.");
        }
    }

    private static String generateCode() {
        return String.format("%06d", RANDOM.nextInt(1_000_000));
    }

    private static String key(Purpose purpose, String email) {
        return purpose.name() + ":" + normalize(email);
    }

    private static String normalize(String email) {
        return email == null ? "" : email.trim().toLowerCase();
    }

    /** 만료 항목 정리. 발송 시점에 호출 — 맵 크기가 작아 부담이 없다. */
    private void prune() {
        long now = System.currentTimeMillis();
        codes.values().removeIf(e -> e.expiresAt <= now);
        verified.values().removeIf(until -> until <= now);
    }

    private static final class CodeEntry {
        private final String code;
        private final long expiresAt;
        private final AtomicInteger attempts = new AtomicInteger(0);

        private CodeEntry(String code, long expiresAt) {
            this.code = code;
            this.expiresAt = expiresAt;
        }

        private boolean isExpired() {
            return expiresAt <= System.currentTimeMillis();
        }
    }
}
