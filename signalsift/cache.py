"""Tiny JSON file cache with TTL, stored under data/."""
import json
import os
import time

import config


def _path(key: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in key)
    return os.path.join(config.DATA_DIR, f"{safe}.json")


def get(key: str, ttl: int, version=None):
    """Return cached payload if present, fresh, and (if given) schema-matched.

    Pass a `version` to opt into schema stamping: a stored payload written with a
    different version (or without one) is treated as stale, so bumping a module's
    schema number auto-invalidates its cache. Omit `version` for raw behaviour.
    """
    path = _path(key)
    if not os.path.exists(path):
        return None
    if time.time() - os.path.getmtime(path) > ttl:
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None

    if version is None:
        return raw
    if isinstance(raw, dict) and raw.get("_schema") == version:
        return raw.get("_payload")
    return None


def set(key: str, payload, version=None) -> None:
    if version is not None:
        payload = {"_schema": version, "_payload": payload}
    path = _path(key)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    os.replace(tmp, path)


def age_seconds(key: str):
    """Seconds since the cache file was written, or None if absent."""
    path = _path(key)
    if not os.path.exists(path):
        return None
    return time.time() - os.path.getmtime(path)
