package com.bbiyong.server.notification.controller;

import com.bbiyong.server.notification.dto.NotificationSettingRequest;
import com.bbiyong.server.notification.dto.NotificationSettingResponse;
import com.bbiyong.server.notification.service.NotificationService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.web.bind.annotation.*;

/**
 * 알림 설정 컨트롤러
 */
@Slf4j
@RestController
@RequestMapping("/api/notifications")
@Tag(name = "Notifications", description = "알림 설정 API")
public class NotificationController {

    private final NotificationService notificationService;

    public NotificationController(NotificationService notificationService) {
        this.notificationService = notificationService;
    }

    /**
     * 현재 사용자의 알림 설정 조회
     */
    @GetMapping("/settings")
    @Operation(summary = "알림 설정 조회", description = "현재 사용자의 알림 설정을 조회합니다. 설정이 없으면 기본값을 반환합니다.")
    public ResponseEntity<NotificationSettingResponse> getSettings(
            @AuthenticationPrincipal UserDetails userDetails) {
        String userId = userDetails.getUsername();
        NotificationSettingResponse response = notificationService.getSettings(userId);
        return ResponseEntity.ok(response);
    }

    /**
     * 알림 설정 업데이트
     */
    @PutMapping("/settings")
    @Operation(summary = "알림 설정 업데이트", description = "Mattermost 알림 설정을 업데이트합니다. 부분 업데이트 가능합니다.")
    public ResponseEntity<NotificationSettingResponse> updateSettings(
            @AuthenticationPrincipal UserDetails userDetails,
            @RequestBody NotificationSettingRequest request) {
        String userId = userDetails.getUsername();
        NotificationSettingResponse response = notificationService.updateSettings(userId, request);
        return ResponseEntity.ok(response);
    }
}
