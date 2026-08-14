package com.bbiyong.server.auth.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * access 토큰 재발급 요청. 로그인 시 받은 refresh 토큰을 전달한다.
 */
public record RefreshRequest(
		@NotBlank String refreshToken
) {
}
