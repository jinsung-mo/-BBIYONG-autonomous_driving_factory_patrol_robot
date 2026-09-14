from dataclasses import dataclass


@dataclass
class CommandWatchdog:
    timeout_sec: float
    last_command_sec: float | None = None

    def record(self, now_sec: float) -> None:
        self.last_command_sec = now_sec

    def expired(self, now_sec: float) -> bool:
        if self.last_command_sec is None:
            return True
        return now_sec - self.last_command_sec > self.timeout_sec
