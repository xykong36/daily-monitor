"""Subtitle extraction: API first, BBDown fallback."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.request

from config import (
    BBDOWN_BIN,
    BILI_REFERER,
    BILI_USER_AGENT,
    BILIBILI_SESSDATA,
    SUBTITLE_MAX_CHARS,
    SUBTITLES_DIR,
)
from src.models import VideoItem

logger = logging.getLogger(__name__)


def _api_headers() -> dict[str, str]:
    headers = {
        "Referer": BILI_REFERER,
        "User-Agent": BILI_USER_AGENT,
    }
    if BILIBILI_SESSDATA:
        headers["Cookie"] = f"SESSDATA={BILIBILI_SESSDATA}"
    return headers


def _fetch_subtitle_via_api(video: VideoItem) -> str | None:
    """Try to get subtitle text via Bilibili player API."""
    if not video.aid or not video.cid:
        return None

    url = f"https://api.bilibili.com/x/player/wbi/v2?aid={video.aid}&cid={video.cid}"
    try:
        req = urllib.request.Request(url, headers=_api_headers())
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        logger.debug("Subtitle API failed for %s: %s", video.bvid, e)
        return None

    subtitles = data.get("data", {}).get("subtitle", {}).get("subtitles", [])
    if not subtitles:
        return None

    # Prefer Chinese subtitle
    sub_url = None
    for s in subtitles:
        lan = s.get("lan", "")
        if "zh" in lan or "cn" in lan:
            sub_url = s.get("subtitle_url", "")
            break
    if not sub_url:
        sub_url = subtitles[0].get("subtitle_url", "")
    if not sub_url:
        return None

    # subtitle_url may start with //
    if sub_url.startswith("//"):
        sub_url = "https:" + sub_url

    try:
        req = urllib.request.Request(sub_url, headers=_api_headers())
        with urllib.request.urlopen(req, timeout=10) as resp:
            sub_data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, OSError, json.JSONDecodeError) as e:
        logger.debug("Subtitle download failed for %s: %s", video.bvid, e)
        return None

    # Extract text from JSON subtitle body
    body = sub_data.get("body", [])
    lines = [item.get("content", "") for item in body if item.get("content")]
    return " ".join(lines) if lines else None


def _parse_srt(srt_text: str) -> str:
    """Extract plain text from SRT content (strip sequence numbers and timestamps)."""
    lines = []
    for line in srt_text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        # Skip sequence numbers (pure digits)
        if re.match(r"^\d+$", line):
            continue
        # Skip timestamp lines
        if re.match(r"^\d{2}:\d{2}:\d{2}", line):
            continue
        lines.append(line)
    return " ".join(lines)


def _fetch_subtitle_via_bbdown(video: VideoItem) -> str | None:
    """Try to get subtitle using BBDown --sub-only."""
    if not BBDOWN_BIN.exists():
        logger.debug("BBDown binary not found at %s", BBDOWN_BIN)
        return None

    video_url = f"https://www.bilibili.com/video/{video.bvid}"
    work_dir = tempfile.mkdtemp(prefix="bbdown_", dir=str(SUBTITLES_DIR))

    try:
        result = subprocess.run(
            [str(BBDOWN_BIN), video_url, "--sub-only", "--work-dir", work_dir],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            logger.debug("BBDown failed for %s: %s", video.bvid, result.stderr[:200])
            return None

        # Find .srt files in work_dir
        for f in os.listdir(work_dir):
            if f.endswith(".srt"):
                srt_path = os.path.join(work_dir, f)
                with open(srt_path, encoding="utf-8", errors="replace") as fh:
                    return _parse_srt(fh.read())
        return None
    except (subprocess.TimeoutExpired, OSError) as e:
        logger.debug("BBDown error for %s: %s", video.bvid, e)
        return None


def extract_subtitle(video: VideoItem) -> str:
    """Extract subtitle text for a video. Returns empty string if unavailable."""
    # Check cache
    cache_path = SUBTITLES_DIR / f"{video.bvid}.txt"
    if cache_path.exists():
        text = cache_path.read_text(encoding="utf-8").strip()
        if text:
            return text[:SUBTITLE_MAX_CHARS]

    # Tier 1: API
    text = _fetch_subtitle_via_api(video)

    # Tier 2: BBDown fallback
    if not text:
        text = _fetch_subtitle_via_bbdown(video)

    if text:
        # Cache it
        cache_path.write_text(text, encoding="utf-8")
        return text[:SUBTITLE_MAX_CHARS]

    return ""
