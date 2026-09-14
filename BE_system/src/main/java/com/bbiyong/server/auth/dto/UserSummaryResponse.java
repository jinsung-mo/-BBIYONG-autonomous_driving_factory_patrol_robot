package com.bbiyong.server.auth.dto;

import com.bbiyong.server.auth.domain.User;

/**
 * 관리자 화면용 사용자 요약(비밀번호 해시 등 민감정보 제외).
 */
public record UserSummaryResponse(
		Long id,
		String email,
		String name,
		String role
) {
	public static UserSummaryResponse from(User user) {
		return new UserSummaryResponse(user.getId(), user.getEmail(), user.getName(), user.getRole().name());
	}
}
