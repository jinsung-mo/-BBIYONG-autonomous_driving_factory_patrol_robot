package com.bbiyong.server.auth.service;

import com.bbiyong.server.auth.dto.LoginRequest;
import com.bbiyong.server.auth.dto.LoginResponse;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class AuthService {

	private static final String ADMIN_USERNAME = "admin01";
	private static final String ADMIN_PASSWORD = "password123!";

	public LoginResponse login(LoginRequest request) {
		if (!ADMIN_USERNAME.equals(request.username()) || !ADMIN_PASSWORD.equals(request.password())) {
			throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "아이디 또는 비밀번호가 올바르지 않습니다.");
		}

		return new LoginResponse("Bearer", "development-access-token", 86400L, "ROLE_ADMIN");
	}
}
