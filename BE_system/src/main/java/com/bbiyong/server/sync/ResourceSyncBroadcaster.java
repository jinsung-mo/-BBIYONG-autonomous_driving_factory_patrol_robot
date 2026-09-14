package com.bbiyong.server.sync;

import lombok.extern.slf4j.Slf4j;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionPhase;
import org.springframework.transaction.event.TransactionalEventListener;
import tools.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * {@link ResourceChangedEvent} 를 {@code /topic/sync} 로 브로드캐스트한다.
 *
 * <p>메시지는 {@code {kind:"resource_sync", resource, robotId?}} 한 형태뿐이다.
 * FE 는 이 토픽 하나만 구독하고 resource 로 갈라 해당 목록만 GET 으로 다시 읽는다
 * (useResourceSync). 자원이 늘어나면 발행 측에 이벤트 한 줄만 추가하면 된다.
 *
 * <p>AFTER_COMMIT 에 발행한다 — 커밋 전에 알리면 클라이언트가 다시 읽어도 옛 값을
 * 받을 수 있고, 롤백되면 없던 변경을 알린 셈이 된다. 트랜잭션 밖에서 발행된 이벤트도
 * 놓치지 않도록 fallbackExecution 을 켠다.
 */
@Slf4j
@Component
public class ResourceSyncBroadcaster {

    public static final String TOPIC = "/topic/sync";

    private final SimpMessagingTemplate messagingTemplate;
    private final ObjectMapper objectMapper;

    public ResourceSyncBroadcaster(SimpMessagingTemplate messagingTemplate, ObjectMapper objectMapper) {
        this.messagingTemplate = messagingTemplate;
        this.objectMapper = objectMapper;
    }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT, fallbackExecution = true)
    public void onResourceChanged(ResourceChangedEvent event) {
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("kind", "resource_sync");
            payload.put("resource", event.resource());
            if (event.robotId() != null) {
                payload.put("robotId", event.robotId());
            }
            messagingTemplate.convertAndSend(TOPIC, objectMapper.writeValueAsString(payload));
        } catch (Exception e) {
            // 동기화 알림은 보조 신호다 — 실패해도 원 요청(REST 응답)은 이미 성공했다.
            log.error("resource_sync 브로드캐스트 실패: {}", event, e);
        }
    }
}
