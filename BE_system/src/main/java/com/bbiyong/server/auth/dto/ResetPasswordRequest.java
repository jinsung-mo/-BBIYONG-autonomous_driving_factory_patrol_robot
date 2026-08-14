package com.bbiyong.server.auth.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;

/**
 * 비밀번호 재설정 요청. send-reset-code 로 받은 인증코드와 새 비밀번호를 함께 제출한다.
 * 비밀번호 강도 규칙은 회원가입과 동일하며 {@link com.bbiyong.server.auth.service.PasswordPolicy} 가 검증한다.
 */
public record ResetPasswordRequest(
		@NotBlank @Email String email,
		@NotBlank String code,
		@NotBlank String newPassword
) {
}
