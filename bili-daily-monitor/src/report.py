"""Generate Material Design HTML report from raw pipeline data."""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

from config import DATA_DIR

logger = logging.getLogger(__name__)


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


def _pub_str(ts: int) -> str:
    if ts <= 0:
        return ""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def generate_report(raw_path: str | Path) -> str:
    """Generate an HTML report from a raw data JSON file. Returns output path."""
    raw_path = Path(raw_path)
    with open(raw_path, encoding="utf-8") as f:
        data = json.load(f)

    videos = data["videos"]
    filter_map = {r["index"]: r for r in data["ai_filter_results"]}
    run_time = data.get("run_time", "")

    # Merge video + filter data
    items = []
    for i, v in enumerate(videos):
        fr = filter_map.get(i, {})
        items.append({**v, **fr, "index": i})

    included = [it for it in items if it.get("include") is True]
    excluded = [it for it in items if it.get("include") is False]
    missing = [it for it in items if it.get("include") is None]

    included.sort(key=lambda x: -x.get("score", 0))
    excluded.sort(key=lambda x: -x.get("view", 0))

    total = len(items)
    inc_count = len(included)
    exc_count = len(excluded)
    miss_count = len(missing)

    html = _render_html(items, included, excluded, missing, run_time, total, inc_count, exc_count, miss_count)

    out_path = raw_path.with_suffix(".html")
    out_path.write_text(html, encoding="utf-8")
    logger.info("HTML report saved to %s", out_path)
    return str(out_path)


def _render_card(it: dict, tier: str) -> str:
    """Render a single video card."""
    bvid = it.get("bvid", "")
    title = it.get("title", "")
    owner = it.get("owner_name", "") or it.get("owner", "")
    owner_mid = it.get("owner_mid", 0)
    pic = it.get("pic", "")
    if pic and not pic.startswith("http"):
        pic = f"https:{pic}"
    video_url = f"https://www.bilibili.com/video/{bvid}"
    up_url = f"https://space.bilibili.com/{owner_mid}"
    score = it.get("score", 0)
    category = it.get("category", "")
    reason = it.get("reason", "")
    summary = it.get("summary", "")
    topic = it.get("topic_analysis", "")
    trending = it.get("trending_reason", "")
    tname = it.get("tname", "")
    source = it.get("source", "")
    pubdate = _pub_str(it.get("pubdate", 0))
    duration = _fmt_duration(it.get("duration", 0))
    view = it.get("view", 0)
    like = it.get("like", 0)
    coin = it.get("coin", 0)
    favorite = it.get("favorite", 0)
    danmaku = it.get("danmaku", 0)
    reply = it.get("reply", 0)
    share = it.get("share", 0)
    desc = (it.get("desc", "") or "")[:200]

    # Score badge color
    if score >= 8:
        score_class = "score-high"
    elif score >= 5:
        score_class = "score-mid"
    else:
        score_class = "score-low"

    # Category chip color
    cat_colors = {
        "AI/大模型": "cat-ai",
        "编程开发": "cat-dev",
        "科技评测": "cat-tech",
        "科学科普": "cat-sci",
        "科技行业": "cat-ind",
    }
    cat_class = cat_colors.get(category, "cat-other")

    # Build analysis section for included top-tier
    analysis_html = ""
    if tier == "top" and (summary or topic or trending):
        parts = []
        if summary:
            parts.append(f'<div class="analysis-block"><div class="analysis-label">📋 内容摘要</div><div class="analysis-text">{summary}</div></div>')
        if topic:
            parts.append(f'<div class="analysis-block"><div class="analysis-label">🎯 选题立意</div><div class="analysis-text">{topic}</div></div>')
        if trending:
            parts.append(f'<div class="analysis-block"><div class="analysis-label">🔥 上热门原因</div><div class="analysis-text">{trending}</div></div>')
        analysis_html = '<div class="analysis-section">' + "".join(parts) + '</div>'
    elif tier == "mid" and summary:
        analysis_html = f'<div class="analysis-section"><div class="analysis-block"><div class="analysis-text">{summary}</div></div></div>'

    # Stats
    stats = f"""
    <div class="stats-row">
        <span class="stat">▶ {_fmt(view)}</span>
        <span class="stat">👍 {_fmt(like)}</span>
        <span class="stat">🪙 {_fmt(coin)}</span>
        <span class="stat">⭐ {_fmt(favorite)}</span>
        <span class="stat">💬 {_fmt(danmaku)}</span>
        <span class="stat">💭 {_fmt(reply)}</span>
        <span class="stat">🔗 {_fmt(share)}</span>
    </div>"""

    meta_parts = []
    if pubdate:
        meta_parts.append(f"📅 {pubdate}")
    if duration:
        meta_parts.append(f"⏱ {duration}")
    if tname:
        meta_parts.append(f"📂 {tname}")
    if source:
        meta_parts.append(f"📡 {source}")
    meta_html = f'<div class="meta-row">{"&nbsp;&nbsp;".join(meta_parts)}</div>' if meta_parts else ""

    reason_html = f'<div class="reason">{reason}</div>' if reason else ""

    thumbnail_html = f'<img class="card-thumb" src="{pic}" alt="" loading="lazy">' if pic else ""

    return f"""
    <div class="card {tier}" data-category="{category}" data-score="{score}" data-source="{source}">
        <div class="card-header">
            {thumbnail_html}
            <div class="card-title-area">
                <a class="card-title" href="{video_url}" target="_blank">{title}</a>
                <div class="card-subtitle">
                    <a class="up-link" href="{up_url}" target="_blank">{owner}</a>
                    {f'<span class="chip {cat_class}">{category}</span>' if category else ''}
                    {f'<span class="score-badge {score_class}">{score}/10</span>' if score else ''}
                </div>
            </div>
        </div>
        {stats}
        {meta_html}
        {reason_html}
        {analysis_html}
        <div class="card-footer">
            <span class="bvid">{bvid}</span>
            <a href="{video_url}" target="_blank" class="link-btn">打开视频</a>
        </div>
    </div>"""


def _render_html(items, included, excluded, missing, run_time, total, inc, exc, miss) -> str:
    # Top tier (score >= 8) and mid tier
    top = [it for it in included if it.get("score", 0) >= 8]
    mid = [it for it in included if it.get("score", 0) < 8]

    top_cards = "\n".join(_render_card(it, "top") for it in top)
    mid_cards = "\n".join(_render_card(it, "mid") for it in mid)
    exc_cards = "\n".join(_render_card(it, "excluded") for it in excluded)
    miss_cards = "\n".join(_render_card(it, "missing") for it in missing)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bilibili 每日精选 — {run_time[:8] if run_time else 'Report'}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/icon?family=Material+Icons+Outlined" rel="stylesheet">
<style>
:root {{
    --md-primary: #1a73e8;
    --md-on-primary: #fff;
    --md-surface: #fff;
    --md-surface-variant: #f1f3f4;
    --md-on-surface: #202124;
    --md-on-surface-variant: #5f6368;
    --md-outline: #dadce0;
    --md-elevation-1: 0 1px 2px 0 rgba(60,64,67,.3), 0 1px 3px 1px rgba(60,64,67,.15);
    --md-elevation-2: 0 1px 2px 0 rgba(60,64,67,.3), 0 2px 6px 2px rgba(60,64,67,.15);
    --md-shape: 12px;
    --md-shape-sm: 8px;
    --color-top: #1a73e8;
    --color-mid: #34a853;
    --color-exc: #9aa0a6;
}}

* {{ margin: 0; padding: 0; box-sizing: border-box; }}

body {{
    font-family: 'Inter', 'Noto Sans SC', -apple-system, sans-serif;
    background: #f8f9fa;
    color: var(--md-on-surface);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
}}

.container {{
    max-width: 960px;
    margin: 0 auto;
    padding: 24px 16px;
}}

/* Header */
.page-header {{
    background: var(--md-primary);
    color: var(--md-on-primary);
    padding: 32px 24px;
    border-radius: var(--md-shape);
    margin-bottom: 24px;
    box-shadow: var(--md-elevation-1);
}}
.page-header h1 {{
    font-size: 24px;
    font-weight: 700;
    margin-bottom: 8px;
    letter-spacing: -0.5px;
}}
.page-header .subtitle {{
    font-size: 14px;
    opacity: 0.87;
}}
.summary-chips {{
    display: flex;
    gap: 8px;
    margin-top: 16px;
    flex-wrap: wrap;
}}
.summary-chip {{
    background: rgba(255,255,255,0.2);
    color: #fff;
    padding: 4px 12px;
    border-radius: 16px;
    font-size: 13px;
    font-weight: 500;
}}

/* Filter bar */
.filter-bar {{
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
    flex-wrap: wrap;
    align-items: center;
}}
.filter-btn {{
    padding: 6px 16px;
    border: 1px solid var(--md-outline);
    border-radius: 20px;
    background: var(--md-surface);
    color: var(--md-on-surface-variant);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    font-family: inherit;
}}
.filter-btn:hover {{
    background: var(--md-surface-variant);
}}
.filter-btn.active {{
    background: var(--md-primary);
    color: var(--md-on-primary);
    border-color: var(--md-primary);
}}

/* Section headers */
.section-header {{
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 32px 0 16px;
    padding-bottom: 8px;
    border-bottom: 2px solid var(--md-outline);
}}
.section-header h2 {{
    font-size: 18px;
    font-weight: 600;
    color: var(--md-on-surface);
}}
.section-header .count {{
    background: var(--md-surface-variant);
    color: var(--md-on-surface-variant);
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
}}

/* Cards */
.card {{
    background: var(--md-surface);
    border-radius: var(--md-shape);
    padding: 16px 20px;
    margin-bottom: 12px;
    box-shadow: var(--md-elevation-1);
    transition: box-shadow 0.2s;
    border-left: 4px solid transparent;
}}
.card:hover {{
    box-shadow: var(--md-elevation-2);
}}
.card.top {{
    border-left-color: var(--color-top);
}}
.card.mid {{
    border-left-color: var(--color-mid);
}}
.card.excluded {{
    border-left-color: var(--color-exc);
    opacity: 0.75;
}}
.card.excluded:hover {{
    opacity: 1;
}}
.card.missing {{
    border-left-color: #ea4335;
    opacity: 0.6;
}}

.card-header {{
    display: flex;
    gap: 16px;
    margin-bottom: 12px;
}}
.card-thumb {{
    width: 120px;
    height: 75px;
    object-fit: cover;
    border-radius: var(--md-shape-sm);
    flex-shrink: 0;
    background: var(--md-surface-variant);
}}
.card-title-area {{
    flex: 1;
    min-width: 0;
}}
.card-title {{
    font-size: 16px;
    font-weight: 600;
    color: var(--md-on-surface);
    text-decoration: none;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.4;
}}
.card-title:hover {{
    color: var(--md-primary);
}}
.card-subtitle {{
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    flex-wrap: wrap;
}}
.up-link {{
    font-size: 13px;
    color: var(--md-on-surface-variant);
    text-decoration: none;
    font-weight: 500;
}}
.up-link:hover {{
    color: var(--md-primary);
}}

/* Chips */
.chip {{
    display: inline-block;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.3px;
}}
.cat-ai {{ background: #fce8e6; color: #c5221f; }}
.cat-dev {{ background: #e6f4ea; color: #137333; }}
.cat-tech {{ background: #e8f0fe; color: #1967d2; }}
.cat-sci {{ background: #f3e8fd; color: #7627bb; }}
.cat-ind {{ background: #fef7e0; color: #b06000; }}
.cat-other {{ background: var(--md-surface-variant); color: var(--md-on-surface-variant); }}

.score-badge {{
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 700;
}}
.score-high {{ background: #e8f0fe; color: #1967d2; }}
.score-mid {{ background: #e6f4ea; color: #137333; }}
.score-low {{ background: var(--md-surface-variant); color: var(--md-on-surface-variant); }}

/* Stats */
.stats-row {{
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    font-size: 12px;
    color: var(--md-on-surface-variant);
    margin-bottom: 8px;
}}
.stat {{
    white-space: nowrap;
}}

.meta-row {{
    font-size: 12px;
    color: var(--md-on-surface-variant);
    margin-bottom: 8px;
}}

.reason {{
    font-size: 13px;
    color: var(--md-on-surface-variant);
    margin-bottom: 8px;
    font-style: italic;
}}

/* Analysis */
.analysis-section {{
    background: var(--md-surface-variant);
    border-radius: var(--md-shape-sm);
    padding: 12px 16px;
    margin: 8px 0;
}}
.analysis-block {{
    margin-bottom: 8px;
}}
.analysis-block:last-child {{
    margin-bottom: 0;
}}
.analysis-label {{
    font-size: 12px;
    font-weight: 600;
    color: var(--md-on-surface);
    margin-bottom: 2px;
}}
.analysis-text {{
    font-size: 13px;
    color: var(--md-on-surface-variant);
    line-height: 1.5;
}}

.card-footer {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--md-outline);
}}
.bvid {{
    font-size: 11px;
    color: var(--md-on-surface-variant);
    font-family: 'Roboto Mono', monospace;
}}
.link-btn {{
    font-size: 12px;
    font-weight: 500;
    color: var(--md-primary);
    text-decoration: none;
    padding: 4px 12px;
    border-radius: 16px;
    transition: background 0.2s;
}}
.link-btn:hover {{
    background: #e8f0fe;
}}

/* Collapsible sections */
.section-content {{
    overflow: hidden;
}}
.section-content.collapsed {{
    display: none;
}}
.toggle-btn {{
    cursor: pointer;
    user-select: none;
    color: var(--md-primary);
    font-size: 13px;
    font-weight: 500;
    margin-left: auto;
}}

@media (max-width: 600px) {{
    .card-thumb {{ width: 80px; height: 50px; }}
    .card-title {{ font-size: 14px; }}
    .stats-row {{ gap: 4px 10px; }}
    .container {{ padding: 12px 8px; }}
}}
</style>
</head>
<body>
<div class="container">

<div class="page-header">
    <h1>📡 Bilibili 每日精选 — 知识·科技·AI</h1>
    <div class="subtitle">运行时间: {run_time} &nbsp;|&nbsp; 数据来源: 综合热门 + 排行榜 + 每周必看</div>
    <div class="summary-chips">
        <span class="summary-chip">📊 共 {total} 个视频</span>
        <span class="summary-chip">🏆 精选 {len(top)} 条</span>
        <span class="summary-chip">📌 推荐 {len(mid)} 条</span>
        <span class="summary-chip">⏭ 排除 {exc} 条</span>
        {f'<span class="summary-chip">⚠ 缺失 {miss} 条</span>' if miss else ''}
    </div>
</div>

<div class="filter-bar">
    <button class="filter-btn active" onclick="filterCards('all')">全部</button>
    <button class="filter-btn" onclick="filterCards('top')">🏆 精选</button>
    <button class="filter-btn" onclick="filterCards('mid')">📌 推荐</button>
    <button class="filter-btn" onclick="filterCards('excluded')">⏭ 排除</button>
    {f'<button class="filter-btn" onclick="filterCards(\'missing\')">⚠ 缺失</button>' if miss else ''}
</div>

<div id="section-top" class="section" data-tier="top">
    <div class="section-header">
        <h2>🏆 精选推荐</h2>
        <span class="count">{len(top)}</span>
    </div>
    <div class="section-content">
        {top_cards if top_cards else '<p style="color:var(--md-on-surface-variant);font-size:14px;">暂无</p>'}
    </div>
</div>

<div id="section-mid" class="section" data-tier="mid">
    <div class="section-header">
        <h2>📌 值得关注</h2>
        <span class="count">{len(mid)}</span>
    </div>
    <div class="section-content">
        {mid_cards if mid_cards else '<p style="color:var(--md-on-surface-variant);font-size:14px;">暂无</p>'}
    </div>
</div>

<div id="section-excluded" class="section" data-tier="excluded">
    <div class="section-header">
        <h2>⏭ 已排除</h2>
        <span class="count">{exc}</span>
        <span class="toggle-btn" onclick="toggleSection('excluded')">展开/收起</span>
    </div>
    <div class="section-content collapsed">
        {exc_cards}
    </div>
</div>

{'<div id="section-missing" class="section" data-tier="missing"><div class="section-header"><h2>⚠ 缺失分析</h2><span class="count">' + str(miss) + '</span><span class="toggle-btn" onclick="toggleSection(\'missing\')">展开/收起</span></div><div class="section-content collapsed">' + miss_cards + '</div></div>' if miss else ''}

</div>

<script>
function filterCards(tier) {{
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');

    document.querySelectorAll('.section').forEach(s => {{
        if (tier === 'all') {{
            s.style.display = '';
        }} else {{
            s.style.display = s.dataset.tier === tier ? '' : 'none';
        }}
    }});

    // Auto-expand if filtering to excluded/missing
    if (tier === 'excluded' || tier === 'missing') {{
        const content = document.querySelector('#section-' + tier + ' .section-content');
        if (content) content.classList.remove('collapsed');
    }}
}}

function toggleSection(tier) {{
    const content = document.querySelector('#section-' + tier + ' .section-content');
    if (content) content.classList.toggle('collapsed');
}}
</script>
</body>
</html>"""
