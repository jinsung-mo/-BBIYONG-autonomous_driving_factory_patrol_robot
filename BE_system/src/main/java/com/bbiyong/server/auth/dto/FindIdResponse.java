package com.bbiyong.server.auth.dto;

/** 아이디(이메일) 찾기 응답. 개인정보 보호를 위해 이메일을 마스킹해 전달한다(예: ki***@gmail.com). */
public record FindIdResponse(
		String maskedEmail
) {
}
