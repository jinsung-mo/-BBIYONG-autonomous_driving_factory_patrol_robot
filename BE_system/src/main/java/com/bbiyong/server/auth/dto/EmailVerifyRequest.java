package com.bbiyong.server.auth.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;

/** 이메일 인증코드 검증 요청. */
public record EmailVerifyRequest(
		@NotBlank @Email String email,
		@NotBlank String code
) {
}
