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
        event.setMessage("[테스트] 화재 감지");
        event.setTimestamp(Instant.now());

        server.expect(requestTo(setting.getMattermostWebhookUrl()))
                .andExpect(method(HttpMethod.POST))
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_FORM_URLENCODED))
                .andExpect(content().string(containsString("payload=")))
                .andExpect(content().string(not(containsString("channel"))))
                .andRespond(withSuccess());

        notifier.sendEventNotification(setting, event);

        server.verify();
    }
}
