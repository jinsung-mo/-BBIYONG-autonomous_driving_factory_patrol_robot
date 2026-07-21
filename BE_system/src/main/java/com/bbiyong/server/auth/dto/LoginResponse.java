package com.bbiyong.server.auth.dto;

public record LoginResponse(
		String tokenType,
		String accessToken,
		long expiresIn,
		String role
) {
}
