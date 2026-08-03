package com.bbiyong.server.wss;

import com.bbiyong.server.wss.event.RobotBinaryVideoEvent;
import org.junit.jupiter.api.Test;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.WebSocketSession;
import tools.jackson.databind.ObjectMapper;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class RobotWebSocketBinaryTests {

    private final ObjectMapper objectMapper = mock(ObjectMapper.class);
    private final ApplicationEventPublisher publisher = mock(ApplicationEventPublisher.class);
    private final RobotWebSocketSessionManager sessions = new RobotWebSocketSessionManager(objectMapper);
    private final RobotWebSocketHandler handler = new RobotWebSocketHandler(sessions, objectMapper, publisher);
    private final WebSocketSession session = mock(WebSocketSession.class);

    @Test
    void registeredRobotBinaryPacketIsPublishedUnchanged() {
        when(session.getId()).thenReturn("session-1");
        sessions.register("orinka_01", session);
        byte[] packet = packet("orinka_01");

        handler.handleBinaryMessage(session, new BinaryMessage(packet));

        verify(publisher).publishEvent(argThat(event -> event instanceof RobotBinaryVideoEvent video
                && video.getRobotId().equals("orinka_01")
                && Arrays.equals(video.getPayload(), packet)));
    }

    @Test
    void mismatchedRobotPacketIsDropped() {
        when(session.getId()).thenReturn("session-1");
        sessions.register("orinka_01", session);

        handler.handleBinaryMessage(session, new BinaryMessage(packet("different_robot")));

        verify(publisher, never()).publishEvent(org.mockito.ArgumentMatchers.any());
    }

    private static byte[] packet(String robotId) {
        byte[] id = robotId.getBytes(StandardCharsets.UTF_8);
        byte[] accessUnit = new byte[] {0, 0, 0, 1, 0x65};
        return ByteBuffer.allocate(40 + id.length + accessUnit.length).order(ByteOrder.BIG_ENDIAN)
                .put(new byte[] {'B', 'B', 'V', '1'})
                .put((byte) 1).put((byte) 3).putShort((short) (40 + id.length))
                .putInt(7).putLong(42).putLong(1_754_000_000_000L)
                .putInt(accessUnit.length).putShort((short) 640).putShort((short) 480)
                .putShort((short) 15).putShort((short) id.length).put(id).put(accessUnit).array();
    }
}
