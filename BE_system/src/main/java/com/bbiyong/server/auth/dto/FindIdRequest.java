package com.bbiyong.server.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.time.LocalDate;

/**
 * 아이디(이메일) 찾기 요청. 이 시스템은 이메일이 곧 로그인 아이디이므로,
 * 이름·휴대전화번호·생년월일이 모두 일치하는 계정의 이메일을 마스킹해 돌려준다.
 */
public record FindIdRequest(
		@NotBlank String name,
		@NotBlank String phoneNumber,
		@NotNull(message = "생년월일은 필수입니다.") LocalDate birthDate
) {
}
