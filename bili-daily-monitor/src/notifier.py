"""Discord webhook notification with rich embeds — tiered output + email."""

from __future__ import annotations

import json
import logging
import smtplib
import time
import urllib.error
import urllib.request
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from config import (
    DISCORD_WEBHOOK_URL,
    GMAIL_APP_PASSWORD,
    GMAIL_USER,
    RECIPIENT_EMAIL,
    SUBTITLES_DIR,
)
from src.models import DigestEntry

logger = logging.getLogger(__name__)

# Discord embed color by category
CATEGORY_COLORS = {
    "AI/大模型": 0xE74C3C,  # red
    "编程开发": 0x2ECC71,  # green
    "科技评测": 0x3498DB,  # blue
    "科学科普": 0x9B59B6,  # purple
    "科技行业": 0xF39C12,  # orange
}
DEFAULT_COLOR = 0x95A5A6  # grey


def _fmt(n: int) -> str:
    if n >= 10_000:
        return f"{n / 10_000:.1f}万"
    return f"{n:,}"


def _fmt_duration(seconds: int) -> str:
    if seconds <= 0:
        return ""
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def _stats_line(v) -> str:
    parts = [f"▶️ {_fmt(v.view)}"]
    if v.like:
        parts.append(f"👍 {_fmt(v.like)}")
    if v.coin:
        parts.append(f"🪙 {_fmt(v.coin)}")
    if v.favorite:
        parts.append(f"⭐ {_fmt(v.favorite)}")
    if v.danmaku:
        parts.append(f"💬 {_fmt(v.danmaku)}")
    if v.reply:
        parts.append(f"💭 {_fmt(v.reply)}")
    if v.share:
        parts.append(f"🔗 {_fmt(v.share)}")
    return "  ".join(parts)


def _meta_line(v) -> str:
    parts = []
    if v.pubdate > 0:
        parts.append(f"📅 {datetime.fromtimestamp(v.pubdate).strftime('%Y-%m-%d %H:%M')}")
    dur = _fmt_duration(v.duration)
    if dur:
        parts.append(f"⏱️ {dur}")
    if v.tname:
        parts.append(f"📂 {v.tname}")
    if v.source:
        parts.append(f"📡 {v.source}")
    return "  ".join(parts)


def _build_top_embed(entry: DigestEntry) -> dict:
    """Full detailed embed for top-tier videos (score >= 8)."""
    v = entry.video
    f = entry.filter_result
    color = CATEGORY_COLORS.get(f.category, DEFAULT_COLOR)
    video_url = f"https://www.bilibili.com/video/{v.bvid}"
    up_url = f"https://space.bilibili.com/{v.owner_mid}"

    # Rich description with full analysis
    desc_parts = []
    if f.summary:
        desc_parts.append(f"**📋 内容摘要**\n{f.summary}")
    if f.topic_analysis:
        desc_parts.append(f"**🎯 选题立意**\n{f.topic_analysis}")
    if f.trending_reason:
        desc_parts.append(f"**🔥 上热门原因**\n{f.trending_reason}")
    description = "\n\n".join(desc_parts) if desc_parts else (f.summary or "")
    if len(description) > 4000:
        description = description[:4000] + "…"

    fields = [
        {"name": "UP主", "value": f"[{v.owner_name}]({up_url})", "inline": True},
        {"name": "分类", "value": f.category, "inline": True},
        {"name": "评分", "value": f"{'⭐' * min(f.score, 5)} {f.score}/10", "inline": True},
        {"name": "互动数据", "value": _stats_line(v), "inline": False},
    ]

    meta = _meta_line(v)
    if meta:
        fields.append({"name": "视频信息", "value": meta, "inline": False})
    if f.reason:
        fields.append({"name": "推荐理由", "value": f.reason, "inline": False})

    # Links
    links = [f"[🎬 视频]({video_url})", f"[👤 UP主]({up_url})"]
    if (SUBTITLES_DIR / f"{v.bvid}.txt").exists():
        links.append(f"📝 字幕已缓存")
    fields.append({"name": "链接", "value": " | ".join(links), "inline": False})

    embed = {
        "title": f"🏆 {v.title}",
        "url": video_url,
        "color": color,
        "description": description,
        "fields": fields,
    }
    if v.pic:
        pic_url = v.pic if v.pic.startswith("http") else f"https:{v.pic}"
        embed["thumbnail"] = {"url": pic_url}
    embed["footer"] = {"text": f"{v.bvid} | AID: {v.aid}"}
    return embed


def _build_mid_embed(entry: DigestEntry) -> dict:
    """Compact embed for mid-tier videos (score 5-7)."""
    v = entry.video
    f = entry.filter_result
    color = CATEGORY_COLORS.get(f.category, DEFAULT_COLOR)
    video_url = f"https://www.bilibili.com/video/{v.bvid}"
    up_url = f"https://space.bilibili.com/{v.owner_mid}"

    # Brief description
    description = f.summary or ""
    if len(description) > 2000:
        description = description[:2000] + "…"

    fields = [
        {"name": "UP主", "value": f"[{v.owner_name}]({up_url})", "inline": True},
        {"name": "分类", "value": f.category, "inline": True},
        {"name": "评分", "value": f"{f.score}/10", "inline": True},
        {"name": "数据", "value": _stats_line(v), "inline": False},
    ]
    meta = _meta_line(v)
    if meta:
        fields.append({"name": "信息", "value": meta, "inline": False})
    if f.reason:
        fields.append({"name": "理由", "value": f.reason, "inline": False})

    embed = {
        "title": v.title,
        "url": video_url,
        "color": color,
        "description": description,
        "fields": fields,
        "footer": {"text": v.bvid},
    }
    if v.pic:
        pic_url = v.pic if v.pic.startswith("http") else f"https:{v.pic}"
        embed["thumbnail"] = {"url": pic_url}
    return embed


def _send_webhook(payload: dict) -> bool:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        DISCORD_WEBHOOK_URL,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Bili-Daily-Monitor/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status not in (200, 204):
                logger.warning("Discord returned status %d", resp.status)
                return False
        return True
    except urllib.error.HTTPError as e:
        logger.error("Discord webhook error: %d %s", e.code, e.read().decode()[:200])
        return False
    except (urllib.error.URLError, OSError) as e:
        logger.error("Discord webhook connection error: %s", e)
        return False


def send_digest(entries: list[DigestEntry]) -> bool:
    """Send filtered videos to Discord, tiered by score."""
    if not DISCORD_WEBHOOK_URL:
        logger.error("DISCORD_WEBHOOK_URL not set, skipping notification")
        return False
    if not entries:
        logger.info("No entries to send")
        return True

    # Sort by score descending
    sorted_entries = sorted(entries, key=lambda e: -e.filter_result.score)

    # Tier split
    top = [e for e in sorted_entries if e.filter_result.score >= 8]
    mid = [e for e in sorted_entries if e.filter_result.score < 8]

    # Header
    header = {
        "content": (
            f"📡 **Bilibili 每日精选 — 知识·科技·AI**\n"
            f"🕐 {datetime.now().strftime('%Y-%m-%d %H:%M')}  "
            f"共 {len(entries)} 条 | 🏆 精选 {len(top)} 条 | 📌 推荐 {len(mid)} 条"
        ),
    }
    if not _send_webhook(header):
        return False
    time.sleep(1)

    # Top tier: full analysis, one per message
    if top:
        if not _send_webhook({"content": "━━━ 🏆 **精选推荐** ━━━"}):
            return False
        time.sleep(0.5)
        for i, entry in enumerate(top):
            embed = _build_top_embed(entry)
            if not _send_webhook({"embeds": [embed]}):
                logger.error("Failed to send top embed %d", i + 1)
                return False
            time.sleep(0.5)

    # Mid tier: compact, batch 5 per message
    if mid:
        if not _send_webhook({"content": "━━━ 📌 **值得关注** ━━━"}):
            return False
        time.sleep(0.5)
        batch_size = 5
        for i in range(0, len(mid), batch_size):
            batch = mid[i : i + batch_size]
            embeds = [_build_mid_embed(e) for e in batch]
            if not _send_webhook({"embeds": embeds}):
                logger.error("Failed to send mid batch at %d", i)
                return False
            time.sleep(1)

    logger.info("Discord: sent %d top + %d mid embeds", len(top), len(mid))
    return True


def _build_email_html(entries: list[DigestEntry]) -> str:
    """Build an HTML email body from digest entries."""
    sorted_entries = sorted(entries, key=lambda e: -e.filter_result.score)
    top = [e for e in sorted_entries if e.filter_result.score >= 8]
    mid = [e for e in sorted_entries if e.filter_result.score < 8]
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    html = f"""<h2>📡 Bilibili 每日精选 — 知识·科技·AI</h2>
<p>🕐 {now} | 共 {len(entries)} 条 | 🏆 精选 {len(top)} 条 | 📌 推荐 {len(mid)} 条</p>"""

    def render_section(title: str, items: list[DigestEntry]) -> str:
        if not items:
            return ""
        s = f"<h3>{title}</h3>"
        for entry in items:
            v = entry.video
            f = entry.filter_result
            url = f"https://www.bilibili.com/video/{v.bvid}"
            up_url = f"https://space.bilibili.com/{v.owner_mid}"
            s += f'<div style="margin-bottom:16px;padding:12px;border:1px solid #ddd;border-radius:8px;">'
            s += f'<b><a href="{url}">{v.title}</a></b> ({f.score}/10)'
            s += f' <span style="background:#eee;padding:2px 6px;border-radius:3px;font-size:12px;">{f.category}</span><br/>'
            s += f'UP: <a href="{up_url}">{v.owner_name}</a> | {_stats_line(v)}<br/>'
            if f.summary:
                s += f"📋 {f.summary}<br/>"
            if f.reason:
                s += f"💡 {f.reason}<br/>"
            s += "</div>"
        return s

    html += render_section("🏆 精选推荐", top)
    html += render_section("📌 值得关注", mid)
    html += '<hr/><p style="color:#999;font-size:12px;">Generated by Bilibili Daily Monitor</p>'
    return html


def send_email(entries: list[DigestEntry]) -> bool:
    """Send digest via Gmail SMTP."""
    if not all([GMAIL_USER, GMAIL_APP_PASSWORD, RECIPIENT_EMAIL]):
        logger.error("Gmail credentials or recipient not set, skipping email")
        return False
    if not entries:
        logger.info("No entries to email")
        return True

    today = datetime.now().strftime("%Y-%m-%d")
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"📡 Bilibili 每日精选 - {today} ({len(entries)} 条)"
    msg["From"] = GMAIL_USER
    msg["To"] = RECIPIENT_EMAIL

    html_body = _build_email_html(entries)
    msg.attach(MIMEText(html_body, "html", "utf-8"))

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as server:
            server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            server.sendmail(GMAIL_USER, RECIPIENT_EMAIL, msg.as_string())
        logger.info("Email sent to %s", RECIPIENT_EMAIL)
        return True
    except Exception as e:
        logger.error("Failed to send email: %s", e)
        return False
