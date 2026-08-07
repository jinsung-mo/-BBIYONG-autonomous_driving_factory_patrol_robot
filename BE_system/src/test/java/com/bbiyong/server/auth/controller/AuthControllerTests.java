package com.bbiyong.server.auth.controller;

import com.bbiyong.server.auth.service.EmailVerificationService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

@SpringBootTest
@AutoConfigureMockMvc
class AuthControllerTests {

	private static final String VALID_PW = "Bbiyong1!";

	@Autowired
	private MockMvc mockMvc;

	// 이메일 인증은 실제 SMTP/코드 흐름 없이 통과시킨다(발송·검증 로직 자체는
	// EmailVerificationServiceTest 에서 단위로 검증). void 모킹 기본값이 no-op 이라
	// requireVerified/sendCode/verifyCode 가 모두 통과된다.
	@MockitoBean
	private EmailVerificationService emailVerificationService;

	/** 확장 필수 필드(휴대전화·생년월일·성별)를 포함한 정상 회원가입 요청 본문. */
	private String signupBody(String email, String password, String name) {
		return """
				{
				  "email": "%s",
				  "password": "%s",
				  "name": "%s",
				  "phoneNumber": "010-1234-5678",
				  "birthDate": "1995-03-15",
				  "gender": "MALE"
				}
				""".formatted(email, password, name);
	}

	private void signup(String email, String password, String name) throws Exception {
		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content(signupBody(email, password, name)))
				.andExpect(status().isCreated());
	}

	@Test
	void signupThenLoginIssuesJwt() throws Exception {
		signup("safety@bbiyong.io", VALID_PW, "E101 관리자");

		mockMvc.perform(post("/api/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "safety@bbiyong.io",
								  "password": "%s"
								}
								""".formatted(VALID_PW)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.tokenType").value("Bearer"))
				.andExpect(jsonPath("$.accessToken").isNotEmpty())
				.andExpect(jsonPath("$.refreshToken").isNotEmpty())
				.andExpect(jsonPath("$.expiresIn").value(3600))
				.andExpect(jsonPath("$.role").value("ROLE_USER"));
	}

	@Test
	void refreshTokenIssuesNewAccessToken() throws Exception {
		signup("refresh@bbiyong.io", VALID_PW, "리프레시 계정");

		String loginBody = mockMvc.perform(post("/api/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "refresh@bbiyong.io",
								  "password": "%s"
								}
								""".formatted(VALID_PW)))
				.andExpect(status().isOk())
				.andReturn().getResponse().getContentAsString();

		String refreshToken = com.jayway.jsonpath.JsonPath.read(loginBody, "$.refreshToken");

		mockMvc.perform(post("/api/auth/refresh")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "refreshToken": "%s"
								}
								""".formatted(refreshToken)))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.tokenType").value("Bearer"))
				.andExpect(jsonPath("$.accessToken").isNotEmpty())
				.andExpect(jsonPath("$.refreshToken").isNotEmpty())
				.andExpect(jsonPath("$.expiresIn").value(3600))
				.andExpect(jsonPath("$.role").value("ROLE_USER"));
	}

	@Test
	void refreshRejectsAccessTokenAsRefresh() throws Exception {
		signup("wrongtyp@bbiyong.io", VALID_PW, "타입오류 계정");

		String loginBody = mockMvc.perform(post("/api/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "wrongtyp@bbiyong.io",
								  "password": "%s"
								}
								""".formatted(VALID_PW)))
				.andExpect(status().isOk())
				.andReturn().getResponse().getContentAsString();

		String accessToken = com.jayway.jsonpath.JsonPath.read(loginBody, "$.accessToken");

		// access 토큰을 refresh 로 사용하면 401
		mockMvc.perform(post("/api/auth/refresh")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "refreshToken": "%s"
								}
								""".formatted(accessToken)))
				.andExpect(status().isUnauthorized());
	}

	@Test
	void signupRejectsDuplicateEmail() throws Exception {
		signup("dup@bbiyong.io", VALID_PW, "중복 계정");

		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content(signupBody("dup@bbiyong.io", "Another1!", "중복 시도")))
				.andExpect(status().isConflict());
	}

	@Test
	void loginReturnsUnauthorizedForWrongPassword() throws Exception {
		signup("wrongpw@bbiyong.io", VALID_PW, "비번틀림 계정");

		mockMvc.perform(post("/api/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "wrongpw@bbiyong.io",
								  "password": "Wrong-password9!"
								}
								"""))
				.andExpect(status().isUnauthorized());
	}

	@Test
	void loginReturnsUnauthorizedForUnknownEmail() throws Exception {
		mockMvc.perform(post("/api/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "nobody@bbiyong.io",
								  "password": "whatever9!"
								}
								"""))
				.andExpect(status().isUnauthorized());
	}

	@Test
	void signupRejectsWeakPasswordWithGuidance() throws Exception {
		// 7자, 특수문자·숫자 없음 → 정책 미충족
		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content(signupBody("weak@bbiyong.io", "abcdefg", "약한비번")))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.detail").value(org.hamcrest.Matchers.containsString("비밀번호에 다음을 포함하세요")));
	}

	@Test
	void signupAcceptsDigitsOnlyPhone() throws Exception {
		// FE 는 하이픈 없이 숫자만 보낸다 — 숫자형 휴대전화도 가입이 통과해야 한다.
		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "digitphone@bbiyong.io",
								  "password": "%s",
								  "name": "숫자전화",
								  "phoneNumber": "01012345678",
								  "birthDate": "1995-03-15",
								  "gender": "MALE"
								}
								""".formatted(VALID_PW)))
				.andExpect(status().isCreated());
	}

	@Test
	void signupRejectsMalformedPhone() throws Exception {
		// 자릿수/형식이 어긋난 값은 여전히 거부된다.
		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "badphone@bbiyong.io",
								  "password": "%s",
								  "name": "전화형식",
								  "phoneNumber": "010-12-3456",
								  "birthDate": "1995-03-15",
								  "gender": "MALE"
								}
								""".formatted(VALID_PW)))
				.andExpect(status().isBadRequest());
	}

	@Test
	void signupRejectsFutureBirthDate() throws Exception {
		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "future@bbiyong.io",
								  "password": "%s",
								  "name": "미래생일",
								  "phoneNumber": "010-1234-5678",
								  "birthDate": "2999-01-01",
								  "gender": "FEMALE"
								}
								""".formatted(VALID_PW)))
				.andExpect(status().isBadRequest());
	}

	@Test
	void signupRejectsInvalidGender() throws Exception {
		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "gender@bbiyong.io",
								  "password": "%s",
								  "name": "성별오류",
								  "phoneNumber": "010-1234-5678",
								  "birthDate": "1995-03-15",
								  "gender": "X"
								}
								""".formatted(VALID_PW)))
				.andExpect(status().isBadRequest());
	}

	@Test
	void signupRejectsMissingRequiredField() throws Exception {
		// phoneNumber 누락
		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "missing@bbiyong.io",
								  "password": "%s",
								  "name": "필드누락",
								  "birthDate": "1995-03-15",
								  "gender": "NONE"
								}
								""".formatted(VALID_PW)))
				.andExpect(status().isBadRequest());
	}

	// ---- 이메일 인증 / 아이디·비밀번호 찾기 ----

	@Test
	void sendSignupCodeReturnsOkForNewEmail() throws Exception {
		mockMvc.perform(post("/api/auth/email/send-code")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{ "email": "newcode@bbiyong.io" }
								"""))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("SUCCESS"));
	}

	@Test
	void sendSignupCodeRejectsAlreadyRegisteredEmail() throws Exception {
		signup("takencode@bbiyong.io", VALID_PW, "이미가입");

		mockMvc.perform(post("/api/auth/email/send-code")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{ "email": "takencode@bbiyong.io" }
								"""))
				.andExpect(status().isConflict());
	}

	@Test
	void verifySignupCodeReturnsOk() throws Exception {
		mockMvc.perform(post("/api/auth/email/verify-code")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{ "email": "verify@bbiyong.io", "code": "123456" }
								"""))
				.andExpect(status().isOk());
	}

	@Test
	void findIdReturnsMaskedEmailForMatchingProfile() throws Exception {
		signup("findme@bbiyong.io", VALID_PW, "찾아줘");

		mockMvc.perform(post("/api/auth/find-id")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "name": "찾아줘",
								  "phoneNumber": "01012345678",
								  "birthDate": "1995-03-15"
								}
								"""))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.maskedEmail").value("fi***@bbiyong.io"));
	}

	@Test
	void findIdReturnsNotFoundForUnknownProfile() throws Exception {
		mockMvc.perform(post("/api/auth/find-id")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "name": "없는사람",
								  "phoneNumber": "01099998888",
								  "birthDate": "1980-01-01"
								}
								"""))
				.andExpect(status().isNotFound());
	}

	@Test
	void sendResetCodeReturnsOkEvenForUnknownEmail() throws Exception {
		// 계정 열거 방지 — 가입 여부와 무관하게 200
		mockMvc.perform(post("/api/auth/password/send-reset-code")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{ "email": "ghost@bbiyong.io" }
								"""))
				.andExpect(status().isOk());
	}

	@Test
	void resetPasswordChangesLoginPassword() throws Exception {
		signup("resetpw@bbiyong.io", VALID_PW, "재설정");

		String newPw = "NewBbiyong9@";
		mockMvc.perform(post("/api/auth/password/reset")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{ "email": "resetpw@bbiyong.io", "code": "123456", "newPassword": "%s" }
								""".formatted(newPw)))
				.andExpect(status().isOk());

		// 새 비밀번호로 로그인 성공
		mockMvc.perform(post("/api/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{ "email": "resetpw@bbiyong.io", "password": "%s" }
								""".formatted(newPw)))
				.andExpect(status().isOk());

		// 옛 비밀번호로는 실패
		mockMvc.perform(post("/api/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{ "email": "resetpw@bbiyong.io", "password": "%s" }
								""".formatted(VALID_PW)))
				.andExpect(status().isUnauthorized());
	}

	@Test
	void resetPasswordRejectsWeakNewPassword() throws Exception {
		signup("resetweak@bbiyong.io", VALID_PW, "약한재설정");

		mockMvc.perform(post("/api/auth/password/reset")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{ "email": "resetweak@bbiyong.io", "code": "123456", "newPassword": "abcdefg" }
								"""))
				.andExpect(status().isBadRequest());
	}
}
