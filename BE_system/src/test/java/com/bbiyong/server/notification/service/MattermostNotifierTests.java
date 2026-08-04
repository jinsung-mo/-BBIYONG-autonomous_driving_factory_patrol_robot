package com.bbiyong.server.notification.service;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.notification.domain.NotificationSetting;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestTemplate;
import tools.jackson.databind.ObjectMapper;

import java.time.Instant;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.not;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.*;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

class MattermostNotifierTests {

    private MockRestServiceServer server;
    private MattermostNotifier notifier;

    @BeforeEach
    void setUp() {
        RestTemplate restTemplate = new RestTemplate();
        server = MockRestServiceServer.bindTo(restTemplate).build();
        notifier = new MattermostNotifier(restTemplate, new ObjectMapper());
    }

    @Test
    void sendsMattermostPayloadAsFormUrlEncoded() {
        NotificationSetting setting = new NotificationSetting();
        setting.setUserId("user@example.com");
        setting.setMattermostWebhookUrl("https://meeting.ssafy.com/hooks/test-webhook");
        setting.setMattermostChannel("legacy-channel");

        EventLog event = new EventLog();
        event.setEventId(1L);
        event.setType("FIRE");
        event.setLevel("CRITICAL");
        event.setMessage("화재 발생");
        event.setConfidence(0.95);
        event.setX(0.0);
        event.setY(0.0);
        event.setTimestamp(Instant.parse("2026-08-04T01:26:17Z"));

        server.expect(requestTo(setting.getMattermostWebhookUrl()))
                .andExpect(method(HttpMethod.POST))
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_FORM_URLENCODED))
                .andExpect(content().string(containsString("payload=")))
                .andExpect(content().string(not(containsString("channel"))))
                .andExpect(content().string(containsString(URLEncoder.encode("화재 발생", StandardCharsets.UTF_8))))
                .andExpect(content().string(containsString("2026-08-04+10%3A26%3A17")))
                .andExpect(content().string(not(containsString(URLEncoder.encode("신뢰도", StandardCharsets.UTF_8)))))
                .andExpect(content().string(not(containsString(URLEncoder.encode("위치", StandardCharsets.UTF_8)))))
                .andRespond(withSuccess());

        notifier.sendEventNotification(setting, event);

        server.verify();
    }
}
