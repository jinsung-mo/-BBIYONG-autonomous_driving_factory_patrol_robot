package com.bbiyong.server.map.service;

import com.bbiyong.server.map.dto.MappingStatusResponse;
import com.bbiyong.server.wss.event.RobotMappingCompleteEvent;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import tools.jackson.databind.ObjectMapper;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

/**
 * 매핑 진행 상태 서비스: 기본 IDLE, START→MAPPING 브로드캐스트, 완료 이벤트→IDLE 전이 검증.
 */
class MappingStatusServiceTests {

    private final SimpMessagingTemplate messagingTemplate = mock(SimpMessagingTemplate.class);
    private final MappingStatusService service =
            new MappingStatusService(messagingTemplate, new ObjectMapper());

    @Test
    void defaultSnapshotIsIdle() {
        MappingStatusResponse snap = service.snapshot("orinka_01");
        assertThat(snap.phase()).isEqualTo("IDLE");
        assertThat(snap.mapping()).isFalse();
        assertThat(snap.since()).isNull();
        assertThat(service.isMapping("orinka_01")).isFalse();
    }

    @Test
    void markMappingSetsMappingAndBroadcasts() {
        service.markMapping("orinka_01");

        assertThat(service.isMapping("orinka_01")).isTrue();
        MappingStatusResponse snap = service.snapshot("orinka_01");
        assertThat(snap.phase()).isEqualTo("MAPPING");
        assertThat(snap.mapping()).isTrue();
        assertThat(snap.since()).isNotNull();
        // /topic/mapping 으로 MAPPING_STATUS 푸시
        verify(messagingTemplate).convertAndSend(eq("/topic/mapping"), contains("MAPPING_STATUS"));
    }

    @Test
    void mappingCompleteEventReturnsToIdle() {
        service.markMapping("orinka_01");
        service.onMappingComplete(new RobotMappingCompleteEvent(this, "orinka_01", "{}"));

        assertThat(service.isMapping("orinka_01")).isFalse();
        assertThat(service.snapshot("orinka_01").phase()).isEqualTo("IDLE");
    }

    @Test
    void blankRobotIdIsIgnored() {
        service.markMapping("");
        service.markMapping(null);
        // 아무 것도 기록/브로드캐스트되지 않는다.
        assertThat(service.isMapping("")).isFalse();
    }
}
