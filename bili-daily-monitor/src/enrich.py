"""Enrich video items with full metadata from Bilibili detail API."""

from __future__ import annotations

import logging
import time

from config import BILI_API_BASE
from src.fetchers.base import bili_request
from src.models import VideoItem

logger = logging.getLogger(__name__)


def enrich_video(v: VideoItem) -> None:
    """Fetch full video detail and update the VideoItem in place."""
    url = f"{BILI_API_BASE}/x/web-interface/view?bvid={v.bvid}"
    try:
        data = bili_request(url)
    except RuntimeError:
        logger.warning("Failed to enrich %s", v.bvid)
        return

    if data.get("code") != 0:
        logger.debug("Enrich API error for %s: %s", v.bvid, data.get("message"))
        return

    d = data.get("data", {})
    stat = d.get("stat", {})

    # Update fields
    v.cid = v.cid or d.get("cid", 0)
    v.desc = v.desc or d.get("desc", "")
    v.tname = v.tname or d.get("tname", "")
    v.duration = v.duration or d.get("duration", 0)
    v.pubdate = d.get("pubdate", 0)
    v.pic = v.pic or d.get("pic", "")

    # Owner info
    owner = d.get("owner", {})
    v.owner_name = v.owner_name or owner.get("name", "")
    v.owner_mid = v.owner_mid or owner.get("mid", 0)

    # Always overwrite stats with latest from detail API
    v.view = stat.get("view", v.view)
    v.like = stat.get("like", v.like)
    v.coin = stat.get("coin", v.coin)
    v.favorite = stat.get("favorite", v.favorite)
    v.share = stat.get("share", v.share)
    v.danmaku = stat.get("danmaku", v.danmaku)
    v.reply = stat.get("reply", v.reply)


def enrich_all(videos: list[VideoItem]) -> None:
    """Enrich all videos with full metadata. Rate-limited."""
    for i, v in enumerate(videos):
        enrich_video(v)
        if (i + 1) % 10 == 0:
            logger.info("Enriched %d/%d videos", i + 1, len(videos))
            time.sleep(0.5)  # rate limit
    logger.info("Enriched %d videos total", len(videos))
