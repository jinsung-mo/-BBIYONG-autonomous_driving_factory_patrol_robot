package com.bbiyong.server.auth.dto;

public record SignupResponse(
		String status,
		String email,
		String name
) {
}
