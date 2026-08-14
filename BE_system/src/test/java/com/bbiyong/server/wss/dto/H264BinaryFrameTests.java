package com.bbiyong.server.wss.dto;

import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class H264BinaryFrameTests {

    @Test
    void parsesVersionOneEnvelope() {
        byte[] packet = packet("orinka_01", 3, new byte[] {0, 0, 0, 1, 0x65});

        H264BinaryFrame frame = H264BinaryFrame.parse(packet);

        assertThat(frame.robotId()).isEqualTo("orinka_01");
        assertThat(frame.keyframe()).isTrue();
        assertThat(frame.codecConfigPresent()).isTrue();
        assertThat(frame.streamId()).isEqualTo(7);
        assertThat(frame.sequence()).isEqualTo(42);
        assertThat(frame.width()).isEqualTo(640);
        assertThat(frame.height()).isEqualTo(480);
        assertThat(frame.fps()).isEqualTo(15);
        assertThat(frame.packet()).isSameAs(packet);
    }

    @Test
    void rejectsLengthMismatchUnknownFlagsAndInvalidUtf8() {
        byte[] truncated = packet("orinka_01", 1, new byte[] {1, 2, 3});
        assertThatThrownBy(() -> H264BinaryFrame.parse(java.util.Arrays.copyOf(truncated, truncated.length - 1)))
                .isInstanceOf(IllegalArgumentException.class);

        assertThatThrownBy(() -> H264BinaryFrame.parse(packet("orinka_01", 4, new byte[] {1})))
                .isInstanceOf(IllegalArgumentException.class);

        byte[] invalidUtf8 = packet("x", 1, new byte[] {1});
        invalidUtf8[40] = (byte) 0xff;
        assertThatThrownBy(() -> H264BinaryFrame.parse(invalidUtf8))
                .isInstanceOf(IllegalArgumentException.class);
    }

    static byte[] packet(String robotId, int flags, byte[] accessUnit) {
        byte[] id = robotId.getBytes(StandardCharsets.UTF_8);
        return ByteBuffer.allocate(40 + id.length + accessUnit.length).order(ByteOrder.BIG_ENDIAN)
                .put(new byte[] {'B', 'B', 'V', '1'})
                .put((byte) 1).put((byte) flags).putShort((short) (40 + id.length))
                .putInt(7).putLong(42).putLong(1_754_000_000_000L)
                .putInt(accessUnit.length).putShort((short) 640).putShort((short) 480)
                .putShort((short) 15).putShort((short) id.length).put(id).put(accessUnit).array();
    }
}
