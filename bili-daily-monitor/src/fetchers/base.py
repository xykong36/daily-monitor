"""HTTP client for Bilibili API requests."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any

from config import BILI_REFERER, BILI_USER_AGENT, BILIBILI_SESSDATA

logger = logging.getLogger(__name__)

MAX_RETRIES = 3
RETRY_DELAY = 2  # seconds


def bili_request(url: str, *, timeout: int = 15) -> dict[str, Any]:
    """Make an HTTP GET request to Bilibili API with retries.

    Returns parsed JSON response body.
    Raises RuntimeError on persistent failure.
    """
    headers = {
        "Referer": BILI_REFERER,
        "User-Agent": BILI_USER_AGENT,
    }
    if BILIBILI_SESSDATA:
        headers["Cookie"] = f"SESSDATA={BILIBILI_SESSDATA}"

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") != 0:
                logger.warning("API error code=%s msg=%s url=%s", data.get("code"), data.get("message"), url)
            return data
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
            logger.warning("Request failed (attempt %d/%d): %s – %s", attempt, MAX_RETRIES, url, e)
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY * attempt)
    raise RuntimeError(f"Failed after {MAX_RETRIES} retries: {url}")
