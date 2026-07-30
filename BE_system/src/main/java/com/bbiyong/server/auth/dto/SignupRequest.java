package com.bbiyong.server.auth.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

import java.time.LocalDate;

/**
 * 회원가입 요청(S15P11E101-498). 관제 계정 담당자 식별을 위해
 * 휴대전화번호·생년월일·성별을 필수로 받는다.
 *
 * <p>존재/형식 검증은 어노테이션으로, 비밀번호 강도·성별 허용값·생년월일 범위 등
 * 구체 메시지가 필요한 규칙은 AuthService 에서 검증한다.
 */
public record SignupRequest(
		@NotBlank @Email String email,
		@NotBlank String password,
		@NotBlank String name,
		@NotBlank @Pattern(regexp = "^010-\\d{4}-\\d{4}$",
				message = "휴대전화번호는 010-0000-0000 형식이어야 합니다.") String phoneNumber,
		@NotNull(message = "생년월일은 필수입니다.") LocalDate birthDate,
		@NotBlank String gender
) {
}
