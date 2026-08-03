package com.bbiyong.server.auth.dto;

/**
 * access 토큰 재발급 응답. refresh 토큰도 함께 회전(rotate)하여 새로 내려준다.
 */
public record RefreshResponse(
		String tokenType,
		String accessToken,
		String refreshToken,
		long expiresIn,
		String role
) {
}
