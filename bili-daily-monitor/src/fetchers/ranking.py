"""Fetch Bilibili 排行榜 (ranking) videos."""

from __future__ import annotations

import logging

from config import BILI_API_BASE, RANKING_RIDS
from src.fetchers.base import bili_request
from src.models import VideoItem

logger = logging.getLogger(__name__)


def _parse_video(v: dict, source: str) -> VideoItem:
    """Parse a standard video object from ranking API."""
    stat = v.get("stat", {})
    return VideoItem(
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
        source=source,
    )


def _fetch_overall_ranking() -> list[VideoItem]:
    """Fetch the overall (rid=0) ranking via ranking/v2."""
    url = f"{BILI_API_BASE}/x/web-interface/ranking/v2?rid=0&type=all"
    data = bili_request(url)
    if data.get("code") != 0:
        logger.warning("Overall ranking returned code %s, skipping", data.get("code"))
        return []
    vlist = data.get("data", {}).get("list", [])
    items = [_parse_video(v, "ranking-全站") for v in vlist]
    logger.info("Ranking 全站 (rid=0): fetched %d videos", len(items))
    return items


def _fetch_region_ranking(rid: int, name: str) -> list[VideoItem]:
    """Fetch recent hot videos in a category via dynamic/region endpoint."""
    url = f"{BILI_API_BASE}/x/web-interface/dynamic/region?rid={rid}&ps=50&pn=1"
    data = bili_request(url)
    if data.get("code") != 0:
        logger.warning("dynamic/region %s (rid=%d) returned code %s, skipping", name, rid, data.get("code"))
        return []
    archives = data.get("data", {}).get("archives", [])
    items = [_parse_video(v, f"ranking-{name}") for v in archives]
    logger.info("Ranking %s (rid=%d): fetched %d videos", name, rid, len(items))
    return items


def fetch_ranking() -> list[VideoItem]:
    """Fetch ranking lists for configured categories."""
    items: list[VideoItem] = []
    for rid, name in RANKING_RIDS.items():
        try:
            if rid == 0:
                items.extend(_fetch_overall_ranking())
            else:
                items.extend(_fetch_region_ranking(rid, name))
        except Exception as e:
            logger.error("Failed to fetch ranking %s (rid=%d): %s", name, rid, e)
    return items
