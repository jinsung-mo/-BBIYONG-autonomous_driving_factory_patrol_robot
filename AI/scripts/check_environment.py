from __future__ import annotations

import platform

import torch
import ultralytics


def main() -> int:
    print(f"python={platform.python_version()}")
    print(f"torch={torch.__version__}")
    print(f"ultralytics={ultralytics.__version__}")
    print(f"cuda_available={torch.cuda.is_available()}")
    print(f"torch_cuda={torch.version.cuda}")
    if not torch.cuda.is_available():
        print("ERROR: CUDA is not available to PyTorch")
        return 1
    print(f"gpu={torch.cuda.get_device_name(0)}")
    total_gib = torch.cuda.get_device_properties(0).total_memory / (1024**3)
    print(f"gpu_memory_gib={total_gib:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

