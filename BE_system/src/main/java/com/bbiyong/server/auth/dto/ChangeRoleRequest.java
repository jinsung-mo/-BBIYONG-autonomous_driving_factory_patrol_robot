package com.bbiyong.server.auth.dto;

import com.bbiyong.server.auth.domain.Role;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

/**
 * 사용자 권한 변경 요청(관리자 전용). 대상 이메일과 부여할 권한을 지정한다.
 */
public record ChangeRoleRequest(
		@NotBlank @Email String email,
		@NotNull Role role
) {
}
