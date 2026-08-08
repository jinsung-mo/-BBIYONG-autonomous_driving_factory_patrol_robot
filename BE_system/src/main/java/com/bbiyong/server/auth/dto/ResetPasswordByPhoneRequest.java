package com.bbiyong.server.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.time.LocalDate;

/**
 * 휴대전화 경로 비밀번호 재설정 요청.
 *
 * <p>이메일 경로({@link ResetPasswordRequest})와 나뉘어 있는 이유: 휴대전화로 계정을 조회하면
 * 사용자는 <b>마스킹된 이메일</b>(ki***@gmail.com)만 받는다. 실제 이메일을 모르므로 이메일 경로의
 * DTO 를 그대로 쓸 수 없고, 그렇다고 그쪽 {@code @NotBlank @Email} 을 선택값으로 풀면 이메일
 * 경로의 검증까지 같이 약해진다. 그래서 본인 확인 3종을 그대로 다시 받아 서버가 계정을 재확인한다.
 *
 * <p>인증코드는 이메일 경로와 <b>같은 저장소</b>(이메일 키)에 들어 있다 — 코드를 받은 곳이
 * 결국 그 계정의 메일함이기 때문이다. 서버가 3종으로 이메일을 되찾아 같은 코드를 검증한다.
 */
public record ResetPasswordByPhoneRequest(
		@NotBlank String name,
		@NotBlank String phoneNumber,
		@NotNull(message = "생년월일은 필수입니다.") LocalDate birthDate,
		@NotBlank String code,
		@NotBlank String newPassword
) {
}
