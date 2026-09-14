package com.bbiyong.server.auth.controller;

import com.bbiyong.server.auth.dto.ChangeRoleRequest;
import com.bbiyong.server.auth.dto.UserSummaryResponse;
import com.bbiyong.server.auth.service.AdminUserService;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 관리자 전용 사용자 관리 API.
 *
 * <p>전 엔드포인트가 {@code ROLE_ADMIN} 필요. 최초 관리자는 프로퍼티 시드
 * ({@code bbiyong.admin.email}/{@code bbiyong.admin.password})로 부트스트랩한다.
 */
@RestController
@RequestMapping("/api/admin/users")
@PreAuthorize("hasRole('ADMIN')")
public class AdminUserController {

    private final AdminUserService adminUserService;

    public AdminUserController(AdminUserService adminUserService) {
        this.adminUserService = adminUserService;
    }

    @GetMapping
    public ResponseEntity<List<UserSummaryResponse>> list() {
        return ResponseEntity.ok(adminUserService.listUsers());
    }

    /** 사용자 권한 변경(관리자 승격/강등). */
    @PatchMapping("/role")
    public ResponseEntity<UserSummaryResponse> changeRole(@Valid @RequestBody ChangeRoleRequest request) {
        return ResponseEntity.ok(adminUserService.changeRole(request.email(), request.role()));
    }
}
