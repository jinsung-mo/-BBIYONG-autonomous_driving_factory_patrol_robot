package com.bbiyong.server.auth.controller;

import com.bbiyong.server.auth.dto.LoginRequest;
import com.bbiyong.server.auth.dto.LoginResponse;
import com.bbiyong.server.auth.dto.SignupRequest;
import com.bbiyong.server.auth.dto.SignupResponse;
import com.bbiyong.server.auth.service.AuthService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "Auth", description = "인증 API (회원가입, 로그인)")
@RestController
@RequestMapping("/api/auth")
public class AuthController {

	private final AuthService authService;

	public AuthController(AuthService authService) {
		this.authService = authService;
	}

	@Operation(
			summary = "관리자 회원가입",
			description = """
					관리자 계정을 이메일 기반으로 신규 등록합니다.

					**비밀번호 정책**:
					- 최소 8자 이상
					- 영문 대소문자, 숫자, 특수문자 중 2가지 이상 조합
					- BCrypt 해시로 안전하게 저장

					**중복 체크**: 이미 존재하는 이메일은 409 Conflict 반환
					"""
	)
	@ApiResponses({
			@ApiResponse(
					responseCode = "201",
					description = "회원가입 성공",
					content = @Content(
							mediaType = "application/json",
							schema = @Schema(implementation = SignupResponse.class)
					)
			),
			@ApiResponse(
					responseCode = "400",
					description = "잘못된 요청 (유효성 검증 실패)"
			),
			@ApiResponse(
					responseCode = "409",
					description = "이미 존재하는 이메일"
			)
	})
	@PostMapping("/signup")
	public ResponseEntity<SignupResponse> signup(@Valid @RequestBody SignupRequest request) {
		return ResponseEntity.status(HttpStatus.CREATED).body(authService.signup(request));
	}

	@Operation(
			summary = "관리자 로그인",
			description = """
					관리자가 이메일/비밀번호로 로그인하고 JWT 토큰을 발급받습니다.

					**응답 정보**:
					- tokenType: Bearer (고정값)
					- accessToken: JWT 액세스 토큰 (유효기간: 24시간)
					- expiresIn: 토큰 만료 시간 (초 단위)
					- role: 사용자 역할 (ROLE_ADMIN)

					**사용법**:
					발급받은 토큰을 이후 API 요청 시 `Authorization: Bearer <accessToken>` 헤더에 포함
					"""
	)
	@ApiResponses({
			@ApiResponse(
					responseCode = "200",
					description = "로그인 성공",
					content = @Content(
							mediaType = "application/json",
							schema = @Schema(implementation = LoginResponse.class)
					)
			),
			@ApiResponse(
					responseCode = "400",
					description = "잘못된 요청 (유효성 검증 실패)"
			),
			@ApiResponse(
					responseCode = "401",
					description = "인증 실패 (이메일 또는 비밀번호 불일치)"
			)
	})
	@PostMapping("/login")
	public ResponseEntity<LoginResponse> login(@Valid @RequestBody LoginRequest request) {
		return ResponseEntity.ok(authService.login(request));
	}
}
