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

	@Autowired
	private MockMvc mockMvc;

	private void signup(String email, String password, String name) throws Exception {
		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "%s",
								  "password": "%s",
								  "name": "%s"
								}
								""".formatted(email, password, name)))
				.andExpect(status().isCreated());
	}

	@Test
	void signupThenLoginIssuesJwt() throws Exception {
		signup("safety@bbiyong.io", "bbiyong", "E101 관리자");

		mockMvc.perform(post("/api/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "safety@bbiyong.io",
								  "password": "bbiyong"
								}
								"""))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.tokenType").value("Bearer"))
				.andExpect(jsonPath("$.accessToken").isNotEmpty())
				.andExpect(jsonPath("$.expiresIn").value(86400))
				.andExpect(jsonPath("$.role").value("ROLE_ADMIN"));
	}

	@Test
	void signupRejectsDuplicateEmail() throws Exception {
		signup("dup@bbiyong.io", "bbiyong", "중복 계정");

		mockMvc.perform(post("/api/auth/signup")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "dup@bbiyong.io",
								  "password": "another",
								  "name": "중복 시도"
								}
								"""))
				.andExpect(status().isConflict());
	}

	@Test
	void loginReturnsUnauthorizedForWrongPassword() throws Exception {
		signup("wrongpw@bbiyong.io", "correct-pw", "비번틀림 계정");

		mockMvc.perform(post("/api/auth/login")
						.contentType(MediaType.APPLICATION_JSON)
						.content("""
								{
								  "email": "wrongpw@bbiyong.io",
								  "password": "wrong-password"
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
								  "password": "whatever"
								}
								"""))
				.andExpect(status().isUnauthorized());
	}
}
