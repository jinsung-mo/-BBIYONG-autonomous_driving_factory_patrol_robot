import struct
import unittest

from h264_protocol import (
    FIXED_HEADER_SIZE,
    H264Packet,
    decode_packet,
    encode_packet,
)


class H264ProtocolTest(unittest.TestCase):
    def packet(self, **changes):
        values = dict(
            robot_id="orinka_01",
            stream_id=123,
            sequence=9,
            timestamp_ms=1_725_000_000_123,
            width=640,
            height=480,
            fps=15,
            keyframe=True,
            codec_config=True,
            payload=b"\x00\x00\x00\x01\x67\x42\x00\x1e",
        )
        values.update(changes)
        return H264Packet(**values)

    def test_round_trip_exact_envelope(self):
        packet = self.packet()
        encoded = encode_packet(packet)
        self.assertEqual(encoded[:4], b"BBV1")
        self.assertEqual(decode_packet(encoded), packet)

    def test_rejects_truncated_and_trailing_bytes(self):
        encoded = encode_packet(self.packet())
        for malformed in (encoded[:20], encoded[:-1], encoded + b"x"):
            with self.subTest(size=len(malformed)), self.assertRaises(ValueError):
                decode_packet(malformed)

    def test_rejects_unknown_version_flags_and_bad_geometry(self):
        encoded = bytearray(encode_packet(self.packet()))
        encoded[4] = 2
        with self.assertRaises(ValueError):
            decode_packet(encoded)
        encoded = bytearray(encode_packet(self.packet()))
        encoded[5] = 0x80
        with self.assertRaises(ValueError):
            decode_packet(encoded)
        with self.assertRaises(ValueError):
            encode_packet(self.packet(fps=0))

    def test_rejects_oversized_payload(self):
        with self.assertRaises(ValueError):
            encode_packet(self.packet(payload=b"x" * (2 * 1024 * 1024 + 1)))

    def test_header_size_field_matches_server_contract(self):
        """header_size 는 payload 직전까지의 **전체** 길이여야 한다.

        서버(H264BinaryFrame.java:69)가 `headerSize != FIXED_HEADER_SIZE + robotIdSize`
        인 패킷을 버린다. 로봇이 고정 40 만 보내는 동안 서버는 초당 30장을 전부
        버렸고, 그런데도 양쪽 단위테스트는 각자 통과했다 — 이 필드를 아무도
        검증하지 않았기 때문이다.

        🔴 왕복 테스트로는 못 잡는다. 인코더와 디코더가 **같이** 틀리면 통과한다.
           그래서 여기서는 바이트를 직접 뜯어 본다.
        """
        for robot_id in ("orinka_01", "r", "로봇-01"):
            with self.subTest(robot_id=robot_id):
                packet = self.packet(robot_id=robot_id)
                encoded = encode_packet(packet)
                header_size = struct.unpack_from(">H", encoded, 6)[0]
                robot_id_size = struct.unpack_from(">H", encoded, 38)[0]
                self.assertEqual(robot_id_size, len(robot_id.encode("utf-8")))
                self.assertEqual(header_size, FIXED_HEADER_SIZE + robot_id_size)
                # 서버는 payload 를 header_size 지점부터 읽는다.
                self.assertEqual(encoded[header_size:], packet.payload)

    def test_rejects_header_size_that_ignores_robot_id(self):
        """고정 40 을 그대로 실은 옛 형식은 거부해야 한다."""
        encoded = bytearray(encode_packet(self.packet()))
        struct.pack_into(">H", encoded, 6, FIXED_HEADER_SIZE)
        with self.assertRaises(ValueError):
            decode_packet(bytes(encoded))


if __name__ == "__main__":
    unittest.main()
