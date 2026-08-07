package com.bbiyong.server.auth.controller;

import com.bbiyong.server.auth.dto.EmailCodeRequest;
import com.bbiyong.server.auth.dto.EmailVerifyRequest;
import com.bbiyong.server.auth.dto.FindIdRequest;
import com.bbiyong.server.auth.dto.FindIdResponse;
import com.bbiyong.server.auth.dto.LoginRequest;
import com.bbiyong.server.auth.dto.LoginResponse;
import com.bbiyong.server.auth.dto.MessageResponse;
import com.bbiyong.server.auth.dto.RefreshRequest;
import com.bbiyong.server.auth.dto.RefreshResponse;
import com.bbiyong.server.auth.dto.ResetPasswordRequest;
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

	@PostMapping("/refresh")
	public ResponseEntity<RefreshResponse> refresh(@Valid @RequestBody RefreshRequest request) {
		return ResponseEntity.ok(authService.refresh(request.refreshToken()));
	}

	@Operation(
			summary = "회원가입 이메일 인증코드 발송",
			description = """
					가입하려는 이메일로 6자리 인증코드를 발송합니다(유효 5분).
					- 이미 가입된 이메일이면 409 Conflict
					- SMTP 자격증명 미설정 시 개발모드: 코드가 서버 로그에 출력됩니다.
					"""
	)
	@PostMapping("/email/send-code")
	public ResponseEntity<MessageResponse> sendSignupCode(@Valid @RequestBody EmailCodeRequest request) {
		authService.sendSignupCode(request.email());
		return ResponseEntity.ok(MessageResponse.ok("인증코드를 발송했습니다. 메일함을 확인하세요."));
	}

	@Operation(
			summary = "회원가입 이메일 인증코드 검증",
			description = "발송된 인증코드를 검증합니다. 성공하면 해당 이메일로 30분 내 회원가입이 가능합니다."
	)
	@PostMapping("/email/verify-code")
	public ResponseEntity<MessageResponse> verifySignupCode(@Valid @RequestBody EmailVerifyRequest request) {
		authService.verifySignupCode(request.email(), request.code());
		return ResponseEntity.ok(MessageResponse.ok("이메일 인증이 완료되었습니다."));
	}

	@Operation(
			summary = "아이디(이메일) 찾기",
			description = """
					이름·휴대전화번호·생년월일이 모두 일치하는 계정의 이메일을 마스킹해 반환합니다
					(예: ki***@gmail.com). 일치 계정이 없으면 404.
					"""
	)
	@PostMapping("/find-id")
	public ResponseEntity<FindIdResponse> findId(@Valid @RequestBody FindIdRequest request) {
		return ResponseEntity.ok(authService.findEmail(request));
	}

	@Operation(
			summary = "비밀번호 재설정 인증코드 발송",
			description = """
					가입된 이메일로 재설정 인증코드를 발송합니다(유효 5분).
					계정 존재 여부를 노출하지 않기 위해, 가입되지 않은 이메일이어도 동일하게 200 을 반환합니다.
					"""
	)
	@PostMapping("/password/send-reset-code")
	public ResponseEntity<MessageResponse> sendResetCode(@Valid @RequestBody EmailCodeRequest request) {
		authService.sendPasswordResetCode(request.email());
		return ResponseEntity.ok(MessageResponse.ok("가입된 이메일이라면 인증코드를 발송했습니다. 메일함을 확인하세요."));
	}

	@Operation(
			summary = "비밀번호 재설정",
			description = "인증코드와 새 비밀번호(정책: 8자 이상·영문·숫자·특수문자)를 제출해 비밀번호를 변경합니다."
	)
	@PostMapping("/password/reset")
	public ResponseEntity<MessageResponse> resetPassword(@Valid @RequestBody ResetPasswordRequest request) {
		authService.resetPassword(request);
		return ResponseEntity.ok(MessageResponse.ok("비밀번호가 변경되었습니다. 새 비밀번호로 로그인하세요."));
	}
}
