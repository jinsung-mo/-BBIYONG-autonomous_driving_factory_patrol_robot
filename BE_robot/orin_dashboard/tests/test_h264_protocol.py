import unittest

from h264_protocol import H264Packet, decode_packet, encode_packet


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


if __name__ == "__main__":
    unittest.main()
