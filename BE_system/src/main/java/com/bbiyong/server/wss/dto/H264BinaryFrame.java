package com.bbiyong.server.wss.dto;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Validated view of a version 1 BBV1 H.264 binary transport packet. */
public final class H264BinaryFrame {

    public static final int FIXED_HEADER_SIZE = 40;
    public static final int MAX_ROBOT_ID_BYTES = 128;
    public static final int MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
    private static final int MAGIC = 0x42425631; // BBV1
    private static final int VERSION = 1;
    private static final int ALLOWED_FLAGS = 0x03;

    private final byte[] packet;
    private final String robotId;
    private final int flags;
    private final long streamId;
    private final long sequence;
    private final long timestampMillis;
    private final int width;
    private final int height;
    private final int fps;

    private H264BinaryFrame(byte[] packet, String robotId, int flags, long streamId,
                            long sequence, long timestampMillis, int width, int height, int fps) {
        this.packet = packet;
        this.robotId = robotId;
        this.flags = flags;
        this.streamId = streamId;
        this.sequence = sequence;
        this.timestampMillis = timestampMillis;
        this.width = width;
        this.height = height;
        this.fps = fps;
    }

    public static H264BinaryFrame parse(byte[] packet) {
        if (packet == null || packet.length < FIXED_HEADER_SIZE) {
            throw new IllegalArgumentException("H.264 packet is shorter than its fixed header");
        }

        ByteBuffer buffer = ByteBuffer.wrap(packet).order(ByteOrder.BIG_ENDIAN);
        int magic = buffer.getInt();
        int version = Byte.toUnsignedInt(buffer.get());
        int flags = Byte.toUnsignedInt(buffer.get());
        int headerSize = Short.toUnsignedInt(buffer.getShort());
        long streamId = Integer.toUnsignedLong(buffer.getInt());
        long sequence = buffer.getLong();
        long timestampMillis = buffer.getLong();
        long payloadSize = Integer.toUnsignedLong(buffer.getInt());
        int width = Short.toUnsignedInt(buffer.getShort());
        int height = Short.toUnsignedInt(buffer.getShort());
        int fps = Short.toUnsignedInt(buffer.getShort());
        int robotIdSize = Short.toUnsignedInt(buffer.getShort());

        if (magic != MAGIC || version != VERSION) {
            throw new IllegalArgumentException("Unsupported H.264 binary protocol");
        }
        if ((flags & ~ALLOWED_FLAGS) != 0) {
            throw new IllegalArgumentException("H.264 packet contains unknown flags");
        }
        if (robotIdSize == 0 || robotIdSize > MAX_ROBOT_ID_BYTES
                || headerSize != FIXED_HEADER_SIZE + robotIdSize) {
            throw new IllegalArgumentException("Invalid H.264 robot identifier/header size");
        }
        if (payloadSize == 0 || payloadSize > MAX_PAYLOAD_BYTES
                || (long) headerSize + payloadSize != packet.length) {
            throw new IllegalArgumentException("Invalid H.264 payload size");
        }
        if (width == 0 || height == 0 || fps == 0) {
            throw new IllegalArgumentException("Invalid H.264 stream geometry");
        }

        byte[] robotIdBytes = Arrays.copyOfRange(packet, FIXED_HEADER_SIZE, headerSize);
        String robotId;
        try {
            robotId = StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(robotIdBytes)).toString();
        } catch (CharacterCodingException e) {
            throw new IllegalArgumentException("Robot identifier is not valid UTF-8", e);
        }
        if (robotId.isBlank()) {
            throw new IllegalArgumentException("Robot identifier is blank");
        }

        return new H264BinaryFrame(packet, robotId, flags, streamId, sequence,
                timestampMillis, width, height, fps);
    }

    public byte[] packet() { return packet; }
    public String robotId() { return robotId; }
    public boolean keyframe() { return (flags & 0x01) != 0; }
    public boolean codecConfigPresent() { return (flags & 0x02) != 0; }
    public long streamId() { return streamId; }
    public long sequence() { return sequence; }
    public long timestampMillis() { return timestampMillis; }
    public int width() { return width; }
    public int height() { return height; }
    public int fps() { return fps; }
}
