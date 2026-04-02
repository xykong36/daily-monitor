"""Fetch Bilibili 综合热门 (popular) videos."""

from __future__ import annotations

import logging

from config import BILI_API_BASE, POPULAR_PAGES, POPULAR_PAGE_SIZE
from src.fetchers.base import bili_request
from src.models import VideoItem

logger = logging.getLogger(__name__)


def fetch_popular() -> list[VideoItem]:
    """Fetch popular video list."""
    items: list[VideoItem] = []
    for pn in range(1, POPULAR_PAGES + 1):
        url = f"{BILI_API_BASE}/x/web-interface/popular?ps={POPULAR_PAGE_SIZE}&pn={pn}"
        data = bili_request(url)
        vlist = data.get("data", {}).get("list", [])
        for v in vlist:
            stat = v.get("stat", {})
            items.append(VideoItem(
                bvid=v["bvid"],
                aid=v["aid"],
                cid=v.get("cid", 0),
                title=v.get("title", ""),
                owner_name=v.get("owner", {}).get("name", ""),
                owner_mid=v.get("owner", {}).get("mid", 0),
                desc=v.get("desc", ""),
                tname=v.get("tname", ""),
                pic=v.get("pic", ""),
                view=stat.get("view", 0),
                like=stat.get("like", 0),
                danmaku=stat.get("danmaku", 0),
                reply=stat.get("reply", 0),
                favorite=stat.get("favorite", 0),
                coin=stat.get("coin", 0),
                share=stat.get("share", 0),
                duration=v.get("duration", 0),
                pubdate=v.get("pubdate", 0),
                source="popular",
            ))
        logger.info("Popular page %d: fetched %d videos", pn, len(vlist))
    return items
