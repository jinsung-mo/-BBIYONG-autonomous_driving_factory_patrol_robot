"""Pure helpers for parsing ESP32 telemetry and translating its clock to ROS time."""

from dataclasses import dataclass


UINT32_MODULUS = 1 << 32
ROLLOVER_HIGH_WATERMARK = 0xF0000000
ROLLOVER_LOW_WATERMARK = 0x0FFFFFFF


@dataclass(frozen=True)
class EncoderTelemetry:
    acquisition_ms: int
    left_count: int
    right_count: int


@dataclass(frozen=True)
class TimestampResult:
    accepted: bool
    stamp_ns: int
    transport_latency_ns: int
    delta_ms: int | None
    reset: bool = False
    rollover: bool = False


def parse_encoder_telemetry(line: str) -> EncoderTelemetry:
    """Parse the firmware's T,millis,...,left_count,right_count record."""
    fields = line.split(",")
    if len(fields) != 11 or fields[0] != "T":
        raise ValueError("not an 11-field ESP32 telemetry record")
    try:
        acquisition_ms = int(fields[1])
        left_count = int(fields[9])
        right_count = int(fields[10])
    except ValueError as exc:
        raise ValueError("telemetry timestamp or encoder count is not an integer") from exc
    if not 0 <= acquisition_ms < UINT32_MODULUS:
        raise ValueError("telemetry timestamp is outside uint32 range")
    return EncoderTelemetry(acquisition_ms, left_count, right_count)


class McuTimeSynchronizer:
    """Translate the ESP32 millisecond clock into the ROS clock domain.

    With a one-way serial link, the smallest observed ``arrival - acquisition``
    is the best available clock-offset estimate. Extra time is transport/queue
    latency. MCU intervals remain authoritative and output stamps stay monotonic.
    """

    def __init__(self) -> None:
        self._last_raw_ms: int | None = None
        self._extended_ms = 0
        self._offset_ns: int | None = None
        self._last_stamp_ns: int | None = None

    def update(self, raw_ms: int, arrival_ns: int) -> TimestampResult:
        if not 0 <= raw_ms < UINT32_MODULUS:
            raise ValueError("MCU timestamp is outside uint32 range")
        if arrival_ns < 0:
            raise ValueError("arrival time must be non-negative")

        reset = False
        rollover = False
        delta_ms: int | None = None

        if self._last_raw_ms is None:
            self._extended_ms = raw_ms
        elif raw_ms == self._last_raw_ms:
            return TimestampResult(
                accepted=False,
                stamp_ns=self._last_stamp_ns or arrival_ns,
                transport_latency_ns=0,
                delta_ms=0,
            )
        elif raw_ms > self._last_raw_ms:
            delta_ms = raw_ms - self._last_raw_ms
            self._extended_ms += delta_ms
        elif (
            self._last_raw_ms >= ROLLOVER_HIGH_WATERMARK
            and raw_ms <= ROLLOVER_LOW_WATERMARK
        ):
            delta_ms = raw_ms + UINT32_MODULUS - self._last_raw_ms
            self._extended_ms += delta_ms
            rollover = True
        else:
            reset = True
            self._extended_ms = raw_ms
            self._offset_ns = None
            self._last_stamp_ns = None

        candidate_offset_ns = arrival_ns - self._extended_ms * 1_000_000
        if self._offset_ns is None or candidate_offset_ns < self._offset_ns:
            self._offset_ns = candidate_offset_ns

        stamp_ns = self._offset_ns + self._extended_ms * 1_000_000
        if self._last_stamp_ns is not None and stamp_ns <= self._last_stamp_ns:
            stamp_ns = self._last_stamp_ns + 1
        latency_ns = max(0, arrival_ns - stamp_ns)

        self._last_raw_ms = raw_ms
        self._last_stamp_ns = stamp_ns
        return TimestampResult(
            accepted=True,
            stamp_ns=stamp_ns,
            transport_latency_ns=latency_ns,
            delta_ms=None if reset else delta_ms,
            reset=reset,
            rollover=rollover,
        )
