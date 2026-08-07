package com.bbiyong.server.auth.service;

import com.bbiyong.server.auth.service.EmailVerificationService.Purpose;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.web.server.ResponseStatusException;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

/**
 * 인메모리 인증코드 서비스의 발송/검증/만료/시도제한 로직 단위 테스트.
 *
 * <p>코드는 랜덤이라 직접 알 수 없으므로, 비(非)개발모드(username 지정)로 두어 실제 발송 경로를
 * 타게 하고 {@link JavaMailSender} 로 전달된 메일 본문에서 코드를 추출해 검증한다.
 */
class EmailVerificationServiceTest {

	private static final Pattern CODE = Pattern.compile("인증코드:\\s*(\\d{6})");

	private EmailVerificationService service(JavaMailSender sender, long codeTtl, int maxAttempts) {
		// username 을 채워 devMode=false → 실제 발송 경로(mailSender.send)를 탄다.
		return new EmailVerificationService(sender, "sender@bbiyong.io",
				"삐용 <no-reply@bbiyong.io>", codeTtl, 1800, maxAttempts);
	}

	private String sendAndCaptureCode(EmailVerificationService svc, JavaMailSender sender,
									   Purpose purpose, String email) {
		svc.sendCode(purpose, email);
		ArgumentCaptor<SimpleMailMessage> captor = ArgumentCaptor.forClass(SimpleMailMessage.class);
		verify(sender).send(captor.capture());
		Matcher m = CODE.matcher(captor.getValue().getText());
		assertThat(m.find()).isTrue();
		return m.group(1);
	}

	@Test
	void verifiesWithCorrectCodeAndMarksVerified() {
		JavaMailSender sender = mock(JavaMailSender.class);
		EmailVerificationService svc = service(sender, 300, 5);

		String code = sendAndCaptureCode(svc, sender, Purpose.SIGNUP, "user@bbiyong.io");
		assertThat(svc.isVerified(Purpose.SIGNUP, "user@bbiyong.io")).isFalse();

		svc.verifyCode(Purpose.SIGNUP, "user@bbiyong.io", code);
		assertThat(svc.isVerified(Purpose.SIGNUP, "user@bbiyong.io")).isTrue();
	}

	@Test
	void normalizesEmailCaseAndWhitespace() {
		JavaMailSender sender = mock(JavaMailSender.class);
		EmailVerificationService svc = service(sender, 300, 5);

		String code = sendAndCaptureCode(svc, sender, Purpose.SIGNUP, "User@Bbiyong.io");
		svc.verifyCode(Purpose.SIGNUP, "  user@bbiyong.io ", code);
		assertThat(svc.isVerified(Purpose.SIGNUP, "USER@BBIYONG.IO")).isTrue();
	}

	@Test
	void rejectsWrongCode() {
		JavaMailSender sender = mock(JavaMailSender.class);
		EmailVerificationService svc = service(sender, 300, 5);
		sendAndCaptureCode(svc, sender, Purpose.SIGNUP, "user@bbiyong.io");

		assertThatThrownBy(() -> svc.verifyCode(Purpose.SIGNUP, "user@bbiyong.io", "000000"))
				.isInstanceOf(ResponseStatusException.class);
		assertThat(svc.isVerified(Purpose.SIGNUP, "user@bbiyong.io")).isFalse();
	}

	@Test
	void rejectsExpiredCode() {
		JavaMailSender sender = mock(JavaMailSender.class);
		EmailVerificationService svc = service(sender, 0, 5); // TTL 0 → 즉시 만료
		String code = sendAndCaptureCode(svc, sender, Purpose.SIGNUP, "user@bbiyong.io");

		assertThatThrownBy(() -> svc.verifyCode(Purpose.SIGNUP, "user@bbiyong.io", code))
				.isInstanceOf(ResponseStatusException.class);
	}

	@Test
	void blocksAfterTooManyAttempts() {
		JavaMailSender sender = mock(JavaMailSender.class);
		EmailVerificationService svc = service(sender, 300, 1); // 시도 1회 초과 시 차단
		sendAndCaptureCode(svc, sender, Purpose.SIGNUP, "user@bbiyong.io");

		// 1회차 오답 — 아직 차단 아님(정상 오류)
		assertThatThrownBy(() -> svc.verifyCode(Purpose.SIGNUP, "user@bbiyong.io", "000000"))
				.isInstanceOf(ResponseStatusException.class);
		// 2회차 — 시도 초과로 코드 폐기
		assertThatThrownBy(() -> svc.verifyCode(Purpose.SIGNUP, "user@bbiyong.io", "000000"))
				.isInstanceOf(ResponseStatusException.class);
	}

	@Test
	void purposesAreIsolated() {
		JavaMailSender sender = mock(JavaMailSender.class);
		EmailVerificationService svc = service(sender, 300, 5);
		String code = sendAndCaptureCode(svc, sender, Purpose.SIGNUP, "user@bbiyong.io");

		// SIGNUP 으로 받은 코드는 PASSWORD_RESET 검증에 쓸 수 없다
		assertThatThrownBy(() -> svc.verifyCode(Purpose.PASSWORD_RESET, "user@bbiyong.io", code))
				.isInstanceOf(ResponseStatusException.class);
	}

	@Test
	void consumeVerifiedClearsState() {
		JavaMailSender sender = mock(JavaMailSender.class);
		EmailVerificationService svc = service(sender, 300, 5);
		String code = sendAndCaptureCode(svc, sender, Purpose.SIGNUP, "user@bbiyong.io");
		svc.verifyCode(Purpose.SIGNUP, "user@bbiyong.io", code);

		svc.consumeVerified(Purpose.SIGNUP, "user@bbiyong.io");
		assertThat(svc.isVerified(Purpose.SIGNUP, "user@bbiyong.io")).isFalse();
	}
}
