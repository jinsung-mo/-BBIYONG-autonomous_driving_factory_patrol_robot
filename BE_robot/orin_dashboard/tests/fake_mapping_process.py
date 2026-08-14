import sys
import signal
import time
from pathlib import Path


mode = sys.argv[1]
def raise_system_exit():
    raise SystemExit(0)


signal.signal(signal.SIGTERM, lambda _signum, _frame: raise_system_exit())


if mode in ("save", "natural"):
    base = Path(sys.argv[2])
    base.parent.mkdir(parents=True, exist_ok=True)
    Path(f"{base}.pgm").write_bytes(b"P5\n2 2\n255\n\x00\x40\x80\xff")
    Path(f"{base}.yaml").write_text(
        "image: ignored.pgm\nresolution: 0.05\norigin: [-1.5, 2.0, 0.25]\n",
        encoding="utf-8",
    )
elif mode == "sleep":
    time.sleep(60)
elif mode == "fail":
    raise SystemExit(3)
elif mode == "success":
    pass
else:
    raise SystemExit(f"unknown fake mode: {mode}")
