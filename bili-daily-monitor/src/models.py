"""Data models for the pipeline."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class VideoItem:
    """A video fetched from Bilibili."""

    bvid: str
    aid: int
    cid: int
    title: str
    owner_name: str
    owner_mid: int
    desc: str
    tname: str  # 分区名
    pic: str  # 封面 URL
    view: int = 0
    like: int = 0
    danmaku: int = 0
    reply: int = 0
    favorite: int = 0
    coin: int = 0
    share: int = 0
    duration: int = 0  # seconds
    pubdate: int = 0  # unix timestamp
    source: str = ""  # which fetcher produced this
    subtitle_text: str = ""  # extracted subtitle content


@dataclass
class FilterResult:
    """AI filter result for a single video."""

    index: int
    include: bool
    category: str
    score: int  # 1-10
    reason: str
    summary: str
    topic_analysis: str = ""  # 选题立意分析
    trending_reason: str = ""  # 上热门原因


@dataclass
class DigestEntry:
    """Final entry ready for Discord notification."""

    video: VideoItem
    filter_result: FilterResult
