"""DeepSeek API content analysis and filtering."""

from __future__ import annotations

import json
import logging
import time

from openai import OpenAI

from config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL
from src.models import FilterResult, VideoItem

logger = logging.getLogger(__name__)

BATCH_SIZE = 15  # videos per API call (keep small to avoid truncation)

SYSTEM_PROMPT = """你是一个内容筛选助手。你的任务是从 Bilibili 视频列表中筛选出知识、科技、AI 自媒体赛道的高质量内容。筛选要严格，宁缺毋滥。

## 筛选标准

### 必须收录（高优先级）
- AI/大模型/机器学习：模型解读、AI 工具教程、行业动态、AI 应用实践
- 编程/计算机科学：编程教程、架构设计、开源项目、技术原理
- 科技深度评测：硬件/软件/数码产品的专业评测和对比
- 科技行业分析：互联网/半导体/芯片/新能源等科技行业深度解读
- 科学知识硬核科普：物理/数学/生物/化学/工程等深度科学内容

### 可以收录（中优先级）
- 科技自媒体对行业趋势的独到见解
- 高质量科技纪录片
- 数码产品首发/拆解/原理分析

### 必须排除
- 经济/金融/股票/投资
- 政治/时事/社会新闻/国际关系
- 历史/哲学/人文社科
- 鬼畜、整活、搞笑、段子
- 动漫/番剧/漫剧/虚拟主播
- 纯娱乐综艺/真人秀/影视剪辑
- 游戏实况/游戏评测
- 追星饭圈/明星八卦
- 美食吃播/探店/旅行vlog
- 情感鸡汤/心灵毒鸡汤
- ASMR/助眠
- 纯颜值/舞蹈/翻唱/音乐
- 宠物日常
- 生活日常/家居装修

## 输出格式

对每个视频输出一个 JSON 对象，所有结果放在一个 JSON 数组中。每个对象包含：
- index: 视频在输入列表中的序号（从0开始，与输入保持一致）
- include: 是否收录（true/false）
- category: 分类标签（如"AI/大模型"、"编程开发"、"科技评测"、"科学科普"、"科技行业"等）
- score: 推荐评分（1-10，10为最高）
- reason: 推荐/排除理由（一句话）
- summary: 视频内容的结构化摘要（3-5句话，概括核心观点和关键信息。对于排除的视频可以只写1句）
- topic_analysis: 选题立意分析（仅对收录视频填写：分析选题角度、内容定位、目标受众，1-2句话。排除的视频留空字符串）
- trending_reason: 上热门原因分析（仅对收录视频填写：分析为什么这个视频能上热门，从内容质量/时效性/受众需求等角度，1-2句话。排除的视频留空字符串）

只输出 JSON 数组，不要有其他文字。"""


def _format_video_info(idx: int, v: VideoItem) -> str:
    """Format a single video's info for the AI prompt."""
    parts = [
        f"[{idx}] 标题: {v.title}",
        f"    UP主: {v.owner_name}",
        f"    分区: {v.tname}",
        f"    播放: {v.view:,}  点赞: {v.like:,}  投币: {v.coin:,}",
    ]
    if v.desc:
        desc = v.desc[:200].replace("\n", " ")
        parts.append(f"    简介: {desc}")
    if v.subtitle_text:
        parts.append(f"    字幕摘要: {v.subtitle_text[:500]}")
    return "\n".join(parts)


def _parse_json_response(content: str) -> list[dict]:
    """Parse AI response, handling markdown fences and truncation."""
    content = content.strip()
    # Strip markdown code fences
    if content.startswith("```"):
        lines = content.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        content = "\n".join(lines)

    # Try direct parse first
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    # If truncated, try progressively shorter substrings to find
    # the last point where valid JSON can be recovered
    for i in range(content.rfind("}"), 0, -1):
        if content[i] != "}":
            continue
        candidate = content[: i + 1].rstrip().rstrip(",") + "\n]"
        if not candidate.lstrip().startswith("["):
            candidate = "[\n" + candidate
        try:
            result = json.loads(candidate)
            logger.warning("Recovered %d items from truncated AI response", len(result))
            return result
        except json.JSONDecodeError:
            continue

    return []


def _filter_batch(client: OpenAI, batch: list[VideoItem], offset: int) -> list[FilterResult]:
    """Filter a single batch of videos."""
    video_texts = [_format_video_info(offset + i, v) for i, v in enumerate(batch)]
    user_prompt = f"请分析以下 {len(batch)} 个 Bilibili 视频，按筛选标准判断是否值得收录：\n\n" + "\n\n".join(video_texts)

    try:
        response = client.chat.completions.create(
            model=DEEPSEEK_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
            max_tokens=8192,
        )
    except Exception as e:
        logger.error("DeepSeek API call failed: %s", e)
        return []

    content = response.choices[0].message.content or ""
    results_raw = _parse_json_response(content)
    if not results_raw:
        logger.error("Failed to parse AI response for batch at offset %d\nContent: %s", offset, content[:500])
        return []

    results = []
    for item in results_raw:
        try:
            results.append(FilterResult(
                index=item["index"],
                include=item["include"],
                category=item.get("category", ""),
                score=item.get("score", 5),
                reason=item.get("reason", ""),
                summary=item.get("summary", ""),
                topic_analysis=item.get("topic_analysis", ""),
                trending_reason=item.get("trending_reason", ""),
            ))
        except (KeyError, TypeError) as e:
            logger.warning("Skipping malformed filter result: %s", e)

    return results


def filter_videos(videos: list[VideoItem]) -> list[FilterResult]:
    """Send videos to DeepSeek API for content filtering in batches.

    Returns a FilterResult for each video.
    """
    if not videos:
        return []

    if not DEEPSEEK_API_KEY:
        logger.error("DEEPSEEK_API_KEY not set, skipping AI filter")
        return []

    client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL)

    all_results: list[FilterResult] = []
    total_batches = (len(videos) + BATCH_SIZE - 1) // BATCH_SIZE

    for batch_idx in range(total_batches):
        start = batch_idx * BATCH_SIZE
        end = min(start + BATCH_SIZE, len(videos))
        batch = videos[start:end]
        logger.info("AI filter batch %d/%d (videos %d-%d)", batch_idx + 1, total_batches, start, end - 1)

        results = _filter_batch(client, batch, start)
        all_results.extend(results)

        # Rate limit between batches
        if batch_idx < total_batches - 1:
            time.sleep(1)

    included = sum(1 for r in all_results if r.include)
    logger.info("AI filter total: %d/%d videos selected", included, len(videos))
    return all_results
