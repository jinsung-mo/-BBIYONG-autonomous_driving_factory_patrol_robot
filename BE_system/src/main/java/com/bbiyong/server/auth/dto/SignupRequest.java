package com.bbiyong.server.auth.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record SignupRequest(
		@NotBlank @Email String email,
		@NotBlank @Size(min = 4) String password,
		@NotBlank String name
) {
}
