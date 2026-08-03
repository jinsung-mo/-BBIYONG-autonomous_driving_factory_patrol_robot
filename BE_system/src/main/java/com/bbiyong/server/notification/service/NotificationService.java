package com.bbiyong.server.notification.service;

import com.bbiyong.server.notification.domain.NotificationSetting;
import com.bbiyong.server.notification.dto.NotificationSettingRequest;
import com.bbiyong.server.notification.dto.NotificationSettingResponse;
import com.bbiyong.server.notification.repository.NotificationSettingRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * 알림 설정 서비스
 */
@Slf4j
@Service
public class NotificationService {

    private final NotificationSettingRepository settingRepository;

    public NotificationService(NotificationSettingRepository settingRepository) {
        this.settingRepository = settingRepository;
    }

    /**
     * 사용자의 알림 설정 조회
     */
    @Transactional(readOnly = true)
    public NotificationSettingResponse getSettings(String userId) {
        NotificationSetting setting = settingRepository.findByUserId(userId)
                .orElseGet(() -> createDefaultSetting(userId));
        return NotificationSettingResponse.from(setting);
    }

    /**
     * 알림 설정 업데이트
     */
    @Transactional
    public NotificationSettingResponse updateSettings(String userId, NotificationSettingRequest request) {
        NotificationSetting setting = settingRepository.findByUserId(userId)
                .orElseGet(() -> createDefaultSetting(userId));

        // 업데이트
        if (request.getMattermostEnabled() != null) {
            setting.setMattermostEnabled(request.getMattermostEnabled());
        }
        if (request.getMattermostWebhookUrl() != null) {
            setting.setMattermostWebhookUrl(request.getMattermostWebhookUrl().trim());
        }
        if (request.getMattermostChannel() != null) {
            setting.setMattermostChannel(request.getMattermostChannel().trim());
        }
        if (request.getMinSeverity() != null) {
            String severity = request.getMinSeverity().trim().toUpperCase();
            if (!severity.equals("CRITICAL") && !severity.equals("WARNING")) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "minSeverity는 CRITICAL 또는 WARNING 이어야 합니다.");
            }
            setting.setMinSeverity(severity);
        }

        NotificationSetting saved = settingRepository.save(setting);
        log.info("알림 설정 업데이트: userId={}, mattermost={}", userId, saved.getMattermostEnabled());
        return NotificationSettingResponse.from(saved);
    }

    /**
     * 기본 설정 생성
     */
    private NotificationSetting createDefaultSetting(String userId) {
        NotificationSetting setting = new NotificationSetting();
        setting.setUserId(userId);
        setting.setMattermostEnabled(false);
        setting.setMinSeverity("WARNING");
        return setting;
    }

    /**
     * 알림을 보내야 하는지 판단 (이벤트 발생 시 호출)
     */
    public boolean shouldNotify(String userId, String eventLevel) {
        NotificationSetting setting = settingRepository.findByUserId(userId).orElse(null);
        return setting != null && shouldNotify(setting, eventLevel);
    }

    public boolean shouldNotify(NotificationSetting setting, String eventLevel) {
        if (!Boolean.TRUE.equals(setting.getMattermostEnabled())) {
            return false;
        }

        // 심각도 필터링
        if ("CRITICAL".equals(setting.getMinSeverity())) {
            return "CRITICAL".equals(eventLevel);
        } else {
            // WARNING 이상: WARNING, CRITICAL 모두 알림
            return "WARNING".equals(eventLevel) || "CRITICAL".equals(eventLevel);
        }
    }
}
