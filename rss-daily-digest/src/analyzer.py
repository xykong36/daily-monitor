import json
import logging
import time

from zhipuai import ZhipuAI

import config

logger = logging.getLogger(__name__)

_client = None


def _get_client() -> ZhipuAI:
    global _client
    if _client is None:
        _client = ZhipuAI(api_key=config.ZHIPUAI_API_KEY)
    return _client


def _llm_call(system: str, user: str, temperature: float = 0.3, retries: int = 3, web_search: bool = False) -> str:
    """Call GLM with retry and exponential backoff."""
    client = _get_client()
    kwargs = dict(
        model=config.ZHIPUAI_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=temperature,
    )
    if web_search:
        kwargs["tools"] = [{"type": "web_search", "web_search": {"enable": True}}]
    for attempt in range(retries):
        try:
            resp = client.chat.completions.create(**kwargs)
            return resp.choices[0].message.content
        except Exception as e:
            wait = 2 ** (attempt + 1)
            logger.warning("LLM call failed (attempt %d/%d): %s. Retrying in %ds...", attempt + 1, retries, e, wait)
            time.sleep(wait)
    raise RuntimeError(f"LLM call failed after {retries} retries")


def _parse_json(text: str) -> dict | list:
    """Parse JSON from LLM response, with progressive fallbacks."""
    import re

    text = text.strip()
    if text.startswith("```"):
        # Remove code fences
        lines = text.split("\n")
        lines = lines[1:]  # remove opening fence
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)

    # Attempt 1: direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Attempt 2: fix common LLM JSON issues
    fixed = re.sub(r',\s*([}\]])', r'\1', text)   # trailing commas
    fixed = re.sub(r'[\x00-\x1f\x7f]', '', fixed)  # control chars
    try:
        return json.loads(fixed)
    except json.JSONDecodeError as e:
        logger.warning("JSON parse failed after regex fix: %s", e)

    # Attempt 3: ask LLM to fix its own JSON
    repair_resp = _llm_call(
        "你是一个 JSON 修复工具。修复以下 JSON 使其合法，只输出修复后的 JSON，不要添加任何其他文字或 code fence。",
        text,
        temperature=0.0,
    )
    return json.loads(repair_resp)


def _truncate_for_analysis(content_text: str) -> str:
    """Truncate long content: keep first 5000 words + last 500 words."""
    words = content_text.split()
    if len(words) <= config.MAX_ANALYSIS_WORDS:
        return content_text
    front = " ".join(words[:5000])
    tail = " ".join(words[-500:])
    return front + "\n\n[...内容过长，已截断中间部分...]\n\n" + tail


def analyze_structure(content_text: str) -> dict:
    """Call 1: Extract detailed outline, key arguments, keywords, and logic chain."""
    truncated = _truncate_for_analysis(content_text)

    system = (
        "你是一位资深产品与科技分析师，擅长深度拆解长文。"
        "请对以下文章进行全面结构化分析，用中文输出，保留英文专业术语。"
        "严格按照 JSON 格式输出，不要添加任何额外文字。"
    )
    user = f"""请对以下文章进行深度结构化分析，输出 JSON 格式：

{{
  "outline_summary": "文章核心摘要（3-5 句话，概括文章在讲什么、核心结论是什么）",
  "detailed_outline": [
    {{
      "heading": "章节/段落主题（如：引言、背景、核心论点1…）",
      "summary": "该部分的内容概要（2-3 句话）",
      "key_points": ["该部分的要点1", "要点2", "要点3"]
    }}
  ],
  "key_arguments": [
    {{
      "argument": "作者提出的核心论点/主张",
      "evidence": "作者用了什么论据来支撑（数据、案例、引用、类比等，尽量具体）",
      "significance": "这个论点为什么重要、对读者意味着什么"
    }}
  ],
  "keywords": [
    {{"term": "关键词", "explanation": "在本文语境下的含义和重要性"}}
  ],
  "logic_chain": "文章的核心推理链条（按照'因为A→所以B→因此C'的方式梳理，覆盖主要推理环节）"
}}

要求：
- detailed_outline 按文章实际结构拆分，覆盖全文，通常 4-8 个章节
- key_arguments 提取 3-6 个最重要的论点，每个都要有具体论据（数据、案例、引用原文关键语句）
- keywords 提取 5-8 个核心关键词
- logic_chain 要清晰展示作者完整的推理过程，不少于 4 个环节
- 分析用中文，保留英文专业术语

文章内容：
{truncated}"""

    raw = _llm_call(system, user)
    return _parse_json(raw)


def analyze_devil_advocate(logic_chain: str, key_arguments: list[dict]) -> list[dict]:
    """Call 2: Search the web for real counter-arguments to key claims."""
    # Build a summary of key arguments for the search prompt
    args_text = "\n".join(
        f"- {a.get('argument', '')}" for a in key_arguments[:5]
    )

    system = (
        "你是一位批判性思维分析师。请联网搜索真实的反面观点、研究或案例来质疑以下论点。"
        "每条对立论证必须引用最近一年内（2025年3月至今）的真实来源（文章、研究、公司案例等），注明出处。"
        "不要使用超过一年前的旧数据。"
        "用中文输出，保留英文专业术语。严格按照 JSON 格式输出，不要添加任何额外文字。"
    )
    user = f"""以下是一篇文章的核心逻辑链和关键论点，请联网搜索最近一年内（2025年3月至今）的真实反面证据，输出精简的对立面论证。

逻辑链：
{logic_chain}

关键论点：
{args_text}

请搜索并输出 JSON 数组（2-3 条最有价值的对立论证即可）：
[
  {{
    "claim": "针对的原文论点（一句话）",
    "counter": "基于真实来源的反面论证（2-3 句话，包含具体事实或数据）",
    "source": "来源名称、日期和链接（如：《Harvard Business Review》2025-06 https://...）"
  }}
]

要求：
- 只保留 2-3 条最有力的对立论证，不要凑数
- 每条必须有最近一年内真实可查的来源，不要使用旧数据，不要编造
- counter 要精简有力，不超过 3 句话"""

    raw = _llm_call(system, user, web_search=True)
    return _parse_json(raw)


def analyze_overall(outline_summary: str, logic_chain: str, devil_advocate: list[dict]) -> str:
    """Call 3: Generate overall assessment."""
    da_text = "\n".join(
        f"- 论点: {d.get('claim', '')}\n  对立: {d.get('counter', '')}\n  来源: {d.get('source', '')}"
        for d in devil_advocate
    )

    system = "你是一位资深内容评论员。请基于结构分析和对立面论证，给出综合评估。用中文输出，保留英文专业术语。"
    user = f"""请基于以下分析结果，撰写一段综合评估（200-400 字）：

大纲摘要：
{outline_summary}

逻辑链：
{logic_chain}

对立面论证：
{da_text}

要求：
- 评估文章的论证质量、实用价值、潜在局限
- 指出最值得关注的观点和最需要警惕的盲区
- 给出阅读建议（适合什么背景的读者、建议关注哪些部分）
- 直接输出评估文本，不需要 JSON 格式"""

    return _llm_call(system, user)


def run_analysis(content_text: str) -> dict:
    """Run the full 3-step analysis pipeline."""
    logger.info("Step 1/3: Structural analysis...")
    structure = analyze_structure(content_text)

    logger.info("Step 2/3: Devil's advocate analysis...")
    devil = analyze_devil_advocate(structure.get("logic_chain", ""), structure.get("key_arguments", []))

    logger.info("Step 3/3: Overall assessment...")
    overall = analyze_overall(
        structure.get("outline_summary", ""),
        structure.get("logic_chain", ""),
        devil,
    )

    return {
        "outline_summary": structure.get("outline_summary", ""),
        "detailed_outline": structure.get("detailed_outline", []),
        "key_arguments": structure.get("key_arguments", []),
        "keywords": structure.get("keywords", []),
        "logic_chain": structure.get("logic_chain", ""),
        "devil_advocate": devil,
        "overall_assessment": overall,
    }
