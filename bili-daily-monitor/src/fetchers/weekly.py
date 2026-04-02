"""Fetch Bilibili 每周必看 (weekly selected) videos."""

from __future__ import annotations

import logging
import re

from config import BILI_APP_BASE
from src.fetchers.base import bili_request
from src.models import VideoItem

logger = logging.getLogger(__name__)


def _get_latest_number() -> int | None:
    """Get the latest weekly selected series number."""
    url = f"{BILI_APP_BASE}/x/v2/show/popular/selected/series?type=weekly_selected"
    data = bili_request(url)
    # data["data"] is a list of series entries directly
    series_list = data.get("data", [])
    if not isinstance(series_list, list) or not series_list:
        logger.warning("No weekly series found")
        return None
    return series_list[0].get("number")


def _parse_view_count(text: str) -> int:
    """Parse view count from text like '1090.2万观看 · 2月7日'."""
    m = re.match(r"([\d.]+)万", text)
    if m:
        return int(float(m.group(1)) * 10_000)
    m = re.match(r"([\d.]+)亿", text)
    if m:
        return int(float(m.group(1)) * 100_000_000)
    m = re.match(r"(\d+)", text)
    if m:
        return int(m.group(1))
    return 0


def fetch_weekly() -> list[VideoItem]:
    """Fetch the latest weekly selected videos."""
    number = _get_latest_number()
    if number is None:
        return []

    url = f"{BILI_APP_BASE}/x/v2/show/popular/selected?type=weekly_selected&number={number}"
    data = bili_request(url)
    vlist = data.get("data", {}).get("list", [])
    items: list[VideoItem] = []
    for v in vlist:
        # Weekly items have a different schema than standard video objects
        aid = int(v.get("param", 0)) if v.get("param", "").isdigit() else 0
        view = _parse_view_count(v.get("right_desc_2", ""))
        items.append(VideoItem(
            bvid=v.get("bvid", ""),
            aid=aid,
            cid=0,
            title=v.get("title", ""),
            owner_name=v.get("right_desc_1", ""),
            owner_mid=v.get("author_id", 0),
            desc=v.get("rcmd_reason", ""),
            tname="",
            pic=v.get("cover", ""),
            view=view,
            source="weekly",
        ))
    logger.info("Weekly #%d: fetched %d videos", number, len(items))
    return items
