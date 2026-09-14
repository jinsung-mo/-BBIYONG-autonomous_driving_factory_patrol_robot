package com.bbiyong.server.notification.service;

import com.bbiyong.server.notification.domain.NotificationSetting;
import com.bbiyong.server.notification.dto.NotificationSettingRequest;
import com.bbiyong.server.notification.dto.NotificationSettingResponse;
import com.bbiyong.server.notification.repository.NotificationSettingRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.net.URI;
import java.util.Arrays;
import java.util.Set;

/**
 * 알림 설정 서비스
 */
@Slf4j
@Service
public class NotificationService {

    private final NotificationSettingRepository settingRepository;
    private final Set<String> allowedWebhookHosts;

    public NotificationService(NotificationSettingRepository settingRepository,
                               @Value("${bbiyong.mattermost.allowed-hosts:meeting.ssafy.com}") String allowedWebhookHosts) {
        this.settingRepository = settingRepository;
        this.allowedWebhookHosts = Arrays.stream(allowedWebhookHosts.split(","))
                .map(String::trim)
                .filter(host -> !host.isBlank())
                .collect(java.util.stream.Collectors.toUnmodifiableSet());
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
            String requestedUrl = request.getMattermostWebhookUrl().trim();
            if (!requestedUrl.endsWith("/****")) {
                setting.setMattermostWebhookUrl(validateWebhookUrl(requestedUrl));
            }
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
        if (Boolean.TRUE.equals(setting.getMattermostEnabled())
                && (setting.getMattermostWebhookUrl() == null || setting.getMattermostWebhookUrl().isBlank())) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Mattermost 알림 활성화에는 웹훅 URL이 필요합니다.");
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

    private String validateWebhookUrl(String value) {
        try {
            URI uri = URI.create(value.trim());
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || uri.getHost() == null
                    || !allowedWebhookHosts.contains(uri.getHost())
                    || !uri.getPath().startsWith("/hooks/")) {
                throw new IllegalArgumentException();
            }
            return uri.toString();
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "허용된 Mattermost HTTPS 웹훅 URL이 아닙니다.");
        }
    }
}
