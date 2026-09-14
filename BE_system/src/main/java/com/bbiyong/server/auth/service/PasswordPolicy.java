package com.bbiyong.server.auth.service;

import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.ArrayList;
import java.util.List;

/**
 * 비밀번호 정책: 8자 이상 + 영문·숫자·특수문자 각 1자 이상.
 *
 * <p>회원가입({@link AuthService#signup})과 비밀번호 재설정에서 동일 규칙을 쓰도록 한곳에 모은다.
 * 미충족 시 부족한 항목을 구체적으로 안내한다(FE 실시간 검사와 문구를 맞춘다).
 */
public final class PasswordPolicy {

    private PasswordPolicy() {
    }

    public static void validate(String password) {
        List<String> missing = new ArrayList<>();
        if (password == null || password.length() < 8) {
            missing.add("8자 이상");
        }
        if (password == null || !password.matches(".*[A-Za-z].*")) {
            missing.add("영문");
        }
        if (password == null || !password.matches(".*\\d.*")) {
            missing.add("숫자");
        }
        if (password == null || !password.matches(".*[^A-Za-z0-9\\s].*")) {
            missing.add("특수문자");
        }
        if (!missing.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "비밀번호에 다음을 포함하세요: " + String.join(", ", missing));
        }
    }
}
