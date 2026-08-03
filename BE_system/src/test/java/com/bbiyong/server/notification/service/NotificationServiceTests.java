package com.bbiyong.server.notification.service;

import com.bbiyong.server.notification.domain.NotificationSetting;
import com.bbiyong.server.notification.dto.NotificationSettingRequest;
import com.bbiyong.server.notification.dto.NotificationSettingResponse;
import com.bbiyong.server.notification.repository.NotificationSettingRepository;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;

class NotificationServiceTests {
    private final NotificationSettingRepository repository = mock(NotificationSettingRepository.class);
    private final NotificationService service = new NotificationService(repository, "meeting.ssafy.com");

    @Test
    void masksWebhookUrlInResponse() {
        NotificationSetting setting = new NotificationSetting();
        setting.setMattermostWebhookUrl("https://meeting.ssafy.com/hooks/secret-token");
        assertThat(NotificationSettingResponse.from(setting).getMattermostWebhookUrl())
                .isEqualTo("https://meeting.ssafy.com/hooks/****");
    }

    @Test
    void rejectsNonMattermostWebhookUrl() {
        NotificationSettingRequest request = new NotificationSettingRequest();
        request.setMattermostWebhookUrl("https://example.com/hooks/x");
        when(repository.findByUserId("admin@bbiyong.io")).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.updateSettings("admin@bbiyong.io", request))
                .isInstanceOf(ResponseStatusException.class)
                .extracting(e -> ((ResponseStatusException) e).getStatusCode().value())
                .isEqualTo(400);
    }
}
