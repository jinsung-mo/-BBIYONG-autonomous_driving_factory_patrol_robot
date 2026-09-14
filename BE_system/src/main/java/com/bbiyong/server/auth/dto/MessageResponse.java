package com.bbiyong.server.auth.dto;

/** 단순 처리 결과 응답(상태 + 사람이 읽는 메시지). */
public record MessageResponse(
		String status,
		String message
) {
	public static MessageResponse ok(String message) {
		return new MessageResponse("SUCCESS", message);
	}
}
