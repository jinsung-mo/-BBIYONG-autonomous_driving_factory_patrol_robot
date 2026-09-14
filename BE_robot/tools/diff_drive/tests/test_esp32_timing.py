import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from esp32_timing import McuTimeSynchronizer, parse_encoder_telemetry  # noqa: E402


class TelemetryParsingTest(unittest.TestCase):
    def test_parses_acquisition_time_and_encoder_counts(self):
        sample = parse_encoder_telemetry(
            "T,1234,1,0.1,0.1,10,0.1,0.1,10,-42,84"
        )
        self.assertEqual(sample.acquisition_ms, 1234)
        self.assertEqual(sample.left_count, -42)
        self.assertEqual(sample.right_count, 84)

    def test_rejects_malformed_record(self):
        with self.assertRaises(ValueError):
            parse_encoder_telemetry("T,1234,1")
        with self.assertRaises(ValueError):
            parse_encoder_telemetry("T,nope,1,0,0,0,0,0,0,1,2")


class McuTimeSynchronizerTest(unittest.TestCase):
    def test_preserves_mcu_intervals_and_reports_transport_latency(self):
        clock = McuTimeSynchronizer()
        first = clock.update(1_000, 2_000_000_000)
        second = clock.update(1_100, 2_130_000_000)

        self.assertTrue(first.accepted)
        self.assertEqual(second.delta_ms, 100)
        self.assertEqual(second.stamp_ns - first.stamp_ns, 100_000_000)
        self.assertEqual(second.transport_latency_ns, 30_000_000)

    def test_rejects_duplicate_timestamp(self):
        clock = McuTimeSynchronizer()
        clock.update(100, 1_000_000_000)
        duplicate = clock.update(100, 1_010_000_000)
        self.assertFalse(duplicate.accepted)
        self.assertEqual(duplicate.delta_ms, 0)

    def test_unwraps_uint32_rollover(self):
        clock = McuTimeSynchronizer()
        first = clock.update(0xFFFFFFF0, 5_000_000_000_000_000)
        second = clock.update(0x00000020, 5_000_000_048_000_000)
        self.assertTrue(second.rollover)
        self.assertFalse(second.reset)
        self.assertEqual(second.delta_ms, 48)
        self.assertEqual(second.stamp_ns - first.stamp_ns, 48_000_000)

    def test_reanchors_after_mcu_reset(self):
        clock = McuTimeSynchronizer()
        clock.update(50_000, 100_000_000_000)
        reset = clock.update(25, 100_100_000_000)
        self.assertTrue(reset.reset)
        self.assertIsNone(reset.delta_ms)
        self.assertEqual(reset.stamp_ns, 100_100_000_000)


if __name__ == "__main__":
    unittest.main()
