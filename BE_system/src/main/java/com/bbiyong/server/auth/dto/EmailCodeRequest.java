package com.bbiyong.server.auth.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;

/** 이메일 인증코드 발송 요청(회원가입 이메일 인증 · 비밀번호 재설정 공통). */
public record EmailCodeRequest(
		@NotBlank @Email String email
) {
}
