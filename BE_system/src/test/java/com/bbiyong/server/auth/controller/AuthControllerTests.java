package com.bbiyong.server.auth.controller;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
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
				.andExpect(jsonPath("$.expiresIn").value(86400))
				.andExpect(jsonPath("$.role").value("ROLE_ADMIN"));
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
	void signupRejectsInvalidPhoneFormat() throws Exception {
		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "phone@bbiyong.io",
								  "password": "%s",
								  "name": "전화형식",
								  "phoneNumber": "01012345678",
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
}
