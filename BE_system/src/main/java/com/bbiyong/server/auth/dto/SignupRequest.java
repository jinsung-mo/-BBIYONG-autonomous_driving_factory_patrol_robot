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
		// FE 는 숫자만 보낸다(하이픈은 화면 표기용). 하이픈 표기도 함께 허용해 양쪽 계약을 포용한다.
		//  - 숫자형: 010 + 7~8자리 (010-XXX-XXXX / 010-XXXX-XXXX 둘 다 정규화하면 10~11자리)
		//  - 표기형: 010-XXX-XXXX 또는 010-XXXX-XXXX
		@NotBlank @Pattern(regexp = "^(010\\d{7,8}|010-\\d{3,4}-\\d{4})$",
				message = "휴대전화번호 형식이 올바르지 않습니다. (예: 01012345678 또는 010-1234-5678)") String phoneNumber,
		@NotNull(message = "생년월일은 필수입니다.") LocalDate birthDate,
		@NotBlank String gender
) {
}
