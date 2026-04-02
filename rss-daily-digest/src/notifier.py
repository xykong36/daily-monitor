import logging
import time

import httpx

import config
from src.models import Article, AnalysisResult

logger = logging.getLogger(__name__)

DISCORD_MSG_LIMIT = 2000


def _send_message(text: str):
    """Send a single Discord message, splitting if needed."""
    resp = httpx.post(
        config.DISCORD_WEBHOOK_URL,
        json={"content": text},
        timeout=15,
    )
    resp.raise_for_status()
    time.sleep(1)


def _send_messages(parts: list[str]):
    """Send multiple message parts, splitting any that exceed the limit."""
    for part in parts:
        if not part.strip():
            continue
        if len(part) <= DISCORD_MSG_LIMIT:
            _send_message(part)
        else:
            # Split long part by lines, accumulate into chunks
            lines = part.split("\n")
            chunk = ""
            for line in lines:
                if len(chunk) + len(line) + 1 > DISCORD_MSG_LIMIT:
                    if chunk.strip():
                        _send_message(chunk)
                    chunk = line + "\n"
                else:
                    chunk += line + "\n"
            if chunk.strip():
                _send_message(chunk)


def send_discord(article: Article, result: AnalysisResult, report_path: str):
    """Send full analysis to Discord via webhook as multiple messages."""
    if not config.DISCORD_WEBHOOK_URL:
        logger.warning("DISCORD_WEBHOOK_URL not set, skipping notification")
        return

    # --- Part 1: Header + Summary ---
    kw_str = ", ".join(kw.get("term", "") for kw in result.keywords[:8])

    part1 = (
        f"📰 **{article.title}**\n"
        f"👤 {article.author} | 📅 {article.pub_date}\n"
        f"🔗 原文: {article.link}\n\n"
        f"💡 **核心摘要：**\n{result.outline_summary}\n\n"
        f"🔑 **关键词：**{kw_str}"
    )

    # --- Part 2: Detailed Outline ---
    outline_lines = ["📑 **详细大纲：**"]
    for i, section in enumerate(result.detailed_outline, 1):
        heading = section.get("heading", "")
        summary = section.get("summary", "")
        key_points = section.get("key_points", [])
        outline_lines.append(f"\n**{i}. {heading}**\n{summary}")
        for pt in key_points:
            outline_lines.append(f"  • {pt}")
    part2 = "\n".join(outline_lines)

    # --- Part 3: Key Arguments ---
    args_lines = ["💡 **核心论点与论据：**"]
    for i, arg in enumerate(result.key_arguments, 1):
        argument = arg.get("argument", "")
        evidence = arg.get("evidence", "")
        significance = arg.get("significance", "")
        args_lines.append(
            f"\n**{i}. {argument}**\n"
            f"📌 论据: {evidence}\n"
            f"⚡ 意义: {significance}"
        )
    part3 = "\n".join(args_lines)

    # --- Part 4: Logic Chain + Devil's Advocate ---
    devil_lines = []
    for i, d in enumerate(result.devil_advocate, 1):
        devil_lines.append(
            f"\n**{i}. {d.get('claim', '')}**\n"
            f"反面论证: {d.get('counter', '')}\n"
            f"来源: {d.get('source', '')}"
        )
    part4 = (
        f"🔗 **逻辑链：**\n{result.logic_chain}\n\n"
        f"⚖️ **对立面论证（基于外部来源）：**"
        + "\n".join(devil_lines)
    )

    # --- Part 5: Overall Assessment ---
    part5 = (
        f"📊 **综合评估：**\n{result.overall_assessment}\n\n"
        f"📄 完整报告: `{report_path}`"
    )

    try:
        _send_messages([part1, part2, part3, part4, part5])
        logger.info("Discord notification sent for: %s", article.title)
    except Exception as e:
        logger.error("Failed to send Discord notification: %s", e)
