"""Trigger the precompute GitHub Action — the manual Refresh path on serverless.

Vercel can't run the ~25s, 500-name live pull inside a request (that's the whole
reason the precompute pipeline exists), so a manual Refresh asks GitHub to run
the same Action the schedule uses. The Action commits a fresh
data/precomputed_screen.json, that push redeploys Vercel, and the client polls
until the new generated_at shows up. Takes a few minutes, but it always works.
"""
import json
import urllib.error
import urllib.request

import config

_API = "https://api.github.com"
_TIMEOUT = 10


def _request(url, data=None, method="GET"):
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode("utf-8") if data is not None else None,
        method=method,
        headers={
            "Authorization": f"Bearer {config.GH_TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "signal-sift",
            "Content-Type": "application/json",
        },
    )
    return urllib.request.urlopen(req, timeout=_TIMEOUT)


def available() -> bool:
    return bool(config.GH_TOKEN)


def dispatch():
    """Queue a precompute run. Returns (ok, message) — message is user-facing."""
    if not available():
        return False, ("No GitHub token on the server, so an off-schedule pull "
                       "isn't available. Set SIGNALSIFT_GH_TOKEN in Vercel to "
                       "enable it.")
    url = (f"{_API}/repos/{config.GH_REPO}/actions/workflows/"
           f"{config.GH_WORKFLOW}/dispatches")
    try:
        with _request(url, data={"ref": config.GH_REF}, method="POST") as res:
            if res.status == 204:
                return True, "Fresh pull queued."
            return False, f"GitHub returned {res.status}."
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return False, "GitHub rejected the token (needs `actions: write`)."
        if e.code == 404:
            return False, f"Workflow or repo not found ({config.GH_REPO})."
        return False, f"GitHub rejected the run ({e.code})."
    except (urllib.error.URLError, OSError) as e:
        return False, f"Couldn't reach GitHub: {e}"
