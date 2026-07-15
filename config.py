"""Central configuration for Signal Sift."""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# On Vercel (and other serverless hosts) the deployment filesystem is read-only
# except for /tmp, so the on-disk cache must live there. Locally it stays under
# the project's data/ folder. Override explicitly with SIGNALSIFT_DATA_DIR.
if os.environ.get("SIGNALSIFT_DATA_DIR"):
    DATA_DIR = os.environ["SIGNALSIFT_DATA_DIR"]
elif os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
    DATA_DIR = "/tmp/signalsift-data"
else:
    DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# SEC requires a descriptive User-Agent with contact info. Override via env var.
SEC_USER_AGENT = os.environ.get(
    "SIGNALSIFT_SEC_UA",
    "Signal Sift Research mohammadhadiahmadi2@gmail.com",
)

# Trailing windows to evaluate, in calendar days. Order = display order.
# Signal Sift is a trend radar: short windows catch recent moves, the multi-year
# windows reveal the long-term trend. All are shown across the whole S&P 500.
WINDOWS = {
    "1D": 1,
    "1W": 7,
    "1M": 30,
    "3M": 91,
    "6M": 182,
    "9M": 273,
    "1Y": 365,
    "2Y": 730,
    "3Y": 1095,
    "4Y": 1460,
    "5Y": 1825,
}

# Days of daily history to pull so the 5-year window has a lookback price.
HISTORY_LOOKBACK_DAYS = 1900

# A window counts as "stalled" (not grown) if the trailing return is at or
# below this ceiling. 0.05 == flat-to-up-5% or worse is considered stalled.
DEFAULT_STALL_CEILING = 0.05

# Benchmark used to compute relative (excess) return.
BENCHMARK = "SPY"

# How long cached data stays fresh (seconds). Signal Sift treats these caches
# like a small database: fast-moving data (prices) expires quickly, while
# slow-moving fundamentals persist for weeks so a price refresh never re-pulls
# financial statements that only change once a quarter.
SCREEN_TTL = 60 * 60 * 6            # 6 hours  — prices / screen
DETAIL_TTL = 60 * 60 * 24           # 24 hours — profile, news, analysts
FUNDAMENTALS_TTL = 60 * 60 * 24 * 30  # 30 days — income/cash-flow statements
LONG_HISTORY_TTL = 60 * 60 * 24 * 3   # 3 days  — 5y price history
