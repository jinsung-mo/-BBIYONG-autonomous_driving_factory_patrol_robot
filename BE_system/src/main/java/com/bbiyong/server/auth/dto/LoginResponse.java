package com.bbiyong.server.auth.dto;

public record LoginResponse(
		String tokenType,
		String accessToken,
		String refreshToken,
		long expiresIn,
		String role
) {
}
