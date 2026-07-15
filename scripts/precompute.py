"""Run the full S&P 500 screen and write it to data/precomputed_screen.json.

Invoked by the `precompute` GitHub Action on a schedule. The committed output is
what the serverless (Vercel) deployment serves, so cold starts are instant instead
of doing a ~25s live pull for 500 names.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: E402
from signalsift import screener  # noqa: E402


def main():
    payload = screener.run_screen(force=True)
    os.makedirs(os.path.dirname(config.PRECOMPUTED_SCREEN), exist_ok=True)
    with open(config.PRECOMPUTED_SCREEN, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print(f"Wrote {config.PRECOMPUTED_SCREEN}: "
          f"{payload['evaluated']}/{payload['universe_size']} names, "
          f"generated {payload['generated_at']}")


if __name__ == "__main__":
    main()
