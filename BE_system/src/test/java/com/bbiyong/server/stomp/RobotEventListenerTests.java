package com.bbiyong.server.stomp;

import com.bbiyong.server.wss.event.RobotConnectedEvent;
import com.bbiyong.server.wss.event.RobotMappingCompleteEvent;
import com.bbiyong.server.wss.event.RobotBinaryVideoEvent;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.Message;
import tools.jackson.databind.ObjectMapper;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.argThat;

/**
 * WSS 이벤트를 STOMP 토픽으로 relay 하는지 검증(직렬화/브로커 없이 대상 토픽만 확인).
 */
class RobotEventListenerTests {

    private final SimpMessagingTemplate messagingTemplate = mock(SimpMessagingTemplate.class);
    private final ObjectMapper objectMapper = mock(ObjectMapper.class);
    private final RobotEventListener listener = new RobotEventListener(messagingTemplate, objectMapper);

    @Test
    void mappingCompleteRelayedToMappingTopic() {
        String rawPayload = "{\"type\":\"EVENT_MAPPING_COMPLETE\",\"robot_id\":\"orinka_01\",\"name\":\"factory_01\"}";

        listener.handleMappingCompleteEvent(new RobotMappingCompleteEvent(this, "orinka_01", rawPayload));

        verify(messagingTemplate).convertAndSend("/topic/mapping", rawPayload);
    }

    @Test
    void connectBroadcastsOnlineStateUpdate() throws Exception {
        // 실제 직렬화 결과를 검증하기 위해 여기서는 진짜 ObjectMapper 를 쓴다.
        ObjectMapper realMapper = new ObjectMapper();
        RobotEventListener realListener = new RobotEventListener(messagingTemplate, realMapper);

        realListener.handleConnect(new RobotConnectedEvent(this, "orinka_01"));

        verify(messagingTemplate).convertAndSend(eq("/topic/robots"), argThat((String json) ->
                json.contains("\"type\":\"STATE_UPDATE\"")
                        && json.contains("\"robot_id\":\"orinka_01\"")
                        && json.contains("\"status\":\"ONLINE\"")
                        && json.contains("\"online\":true")));
    }

    @Test
    void binaryVideoRelayedWithoutJsonConversion() {
        byte[] payload = new byte[] {1, 2, 3, 4};

        listener.handleBinaryVideoEvent(new RobotBinaryVideoEvent(this, "orinka_01", payload));

        verify(messagingTemplate).send(eq("/topic/video/orinka_01"), argThat((Message<?> message) ->
                message.getPayload() == payload
                        && "application/octet-stream".equals(message.getHeaders().get("contentType").toString())));
    }
}
