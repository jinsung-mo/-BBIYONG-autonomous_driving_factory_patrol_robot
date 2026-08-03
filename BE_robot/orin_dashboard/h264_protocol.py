#!/usr/bin/env python3
"""Versioned binary envelope for robot H.264 access units.

All integers are network-byte-order.  The fixed 40-byte header is followed by
UTF-8 robot_id bytes and one Annex-B H.264 access unit.
"""

from dataclasses import dataclass
import struct


MAGIC = b"BBV1"
VERSION = 1
FIXED_HEADER = struct.Struct(">4sBBHIQQIHHHH")
FIXED_HEADER_SIZE = FIXED_HEADER.size
FLAG_KEYFRAME = 0x01
FLAG_CODEC_CONFIG = 0x02
MAX_ROBOT_ID_BYTES = 128
MAX_PAYLOAD_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class H264Packet:
    robot_id: str
    stream_id: int
    sequence: int
    timestamp_ms: int
    width: int
    height: int
    fps: int
    keyframe: bool
    codec_config: bool
    payload: bytes


def encode_packet(packet):
    robot_id = packet.robot_id.encode("utf-8")
    payload = bytes(packet.payload)
    if not robot_id or len(robot_id) > MAX_ROBOT_ID_BYTES:
        raise ValueError("robot_id length is invalid")
    if not payload or len(payload) > MAX_PAYLOAD_BYTES:
        raise ValueError("H.264 payload length is invalid")
    for name, value, maximum in (
        ("stream_id", packet.stream_id, 0xFFFFFFFF),
        ("sequence", packet.sequence, 0xFFFFFFFFFFFFFFFF),
        ("timestamp_ms", packet.timestamp_ms, 0xFFFFFFFFFFFFFFFF),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
            raise ValueError(f"{name} is invalid")
    for name, value in (("width", packet.width), ("height", packet.height)):
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 8192:
            raise ValueError(f"{name} is invalid")
    if isinstance(packet.fps, bool) or not isinstance(packet.fps, int) or not 1 <= packet.fps <= 240:
        raise ValueError("fps is invalid")
    flags = 0
    if packet.keyframe:
        flags |= FLAG_KEYFRAME
    if packet.codec_config:
        flags |= FLAG_CODEC_CONFIG
    header = FIXED_HEADER.pack(
        MAGIC,
        VERSION,
        flags,
        FIXED_HEADER_SIZE,
        packet.stream_id,
        packet.sequence,
        packet.timestamp_ms,
        len(payload),
        packet.width,
        packet.height,
        packet.fps,
        len(robot_id),
    )
    return header + robot_id + payload


def decode_packet(data):
    data = bytes(data)
    if len(data) < FIXED_HEADER_SIZE:
        raise ValueError("truncated H.264 packet header")
    (
        magic,
        version,
        flags,
        header_size,
        stream_id,
        sequence,
        timestamp_ms,
        payload_size,
        width,
        height,
        fps,
        robot_id_size,
    ) = FIXED_HEADER.unpack_from(data)
    if magic != MAGIC or version != VERSION or header_size != FIXED_HEADER_SIZE:
        raise ValueError("unsupported H.264 packet envelope")
    if flags & ~(FLAG_KEYFRAME | FLAG_CODEC_CONFIG):
        raise ValueError("unsupported H.264 packet flags")
    if not 1 <= robot_id_size <= MAX_ROBOT_ID_BYTES:
        raise ValueError("robot_id length is invalid")
    if not 1 <= payload_size <= MAX_PAYLOAD_BYTES:
        raise ValueError("H.264 payload length is invalid")
    expected = FIXED_HEADER_SIZE + robot_id_size + payload_size
    if len(data) != expected:
        raise ValueError("H.264 packet length does not match header")
    try:
        robot_id = data[FIXED_HEADER_SIZE:FIXED_HEADER_SIZE + robot_id_size].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("robot_id is not UTF-8") from exc
    if not robot_id:
        raise ValueError("robot_id is empty")
    if not (1 <= width <= 8192 and 1 <= height <= 8192 and 1 <= fps <= 240):
        raise ValueError("video geometry is invalid")
    payload = data[FIXED_HEADER_SIZE + robot_id_size:]
    return H264Packet(
        robot_id=robot_id,
        stream_id=stream_id,
        sequence=sequence,
        timestamp_ms=timestamp_ms,
        width=width,
        height=height,
        fps=fps,
        keyframe=bool(flags & FLAG_KEYFRAME),
        codec_config=bool(flags & FLAG_CODEC_CONFIG),
        payload=payload,
    )
