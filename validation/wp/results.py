"""Merge a section into docs/results.json (read-modify-write under a file lock).

Each script owns one top-level section key. Every headline number should be stored as
{"value": ..., "unit": ..., "n": ..., "script": ..., "note": ...}.
"""
import fcntl
import json
import datetime as _dt
from .config import RESULTS_JSON


def metric(value, unit, n=None, script=None, note=None):
    d = {"value": value, "unit": unit}
    if n is not None:
        d["n"] = n
    if script is not None:
        d["script"] = script
    if note is not None:
        d["note"] = note
    return d


def update_results(section: str, payload: dict) -> None:
    RESULTS_JSON.parent.mkdir(parents=True, exist_ok=True)
    lock = RESULTS_JSON.with_suffix(".lock")
    with open(lock, "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        data = {}
        if RESULTS_JSON.exists():
            data = json.loads(RESULTS_JSON.read_text() or "{}")
        data.setdefault("_meta", {})["updated_utc"] = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")
        data[section] = payload
        RESULTS_JSON.write_text(json.dumps(data, indent=2, sort_keys=False, default=float) + "\n")
        fcntl.flock(lf, fcntl.LOCK_UN)
