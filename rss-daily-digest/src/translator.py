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


def _llm_call(system: str, user: str, temperature: float = 0.2, retries: int = 3) -> str:
    client = _get_client()
    for attempt in range(retries):
        try:
            resp = client.chat.completions.create(
                model=config.ZHIPUAI_MODEL,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=temperature,
            )
            return resp.choices[0].message.content
        except Exception as e:
            wait = 2 ** (attempt + 1)
            logger.warning("Translation LLM call failed (attempt %d/%d): %s. Retrying in %ds...", attempt + 1, retries, e, wait)
            time.sleep(wait)
    raise RuntimeError(f"Translation LLM call failed after {retries} retries")


def _parse_json(text: str) -> list:
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    return json.loads(text)


def _chunk_paragraphs(paragraphs: list[str], max_chars: int = config.MAX_CHUNK_CHARS) -> list[list[str]]:
    """Group paragraphs into chunks that fit within max_chars."""
    chunks = []
    current_chunk = []
    current_len = 0

    for p in paragraphs:
        if current_len + len(p) > max_chars and current_chunk:
            chunks.append(current_chunk)
            current_chunk = []
            current_len = 0
        current_chunk.append(p)
        current_len += len(p)

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def translate_paragraphs(paragraphs: list[str]) -> list[dict]:
    """Translate paragraphs in chunks, returning bilingual pairs."""
    chunks = _chunk_paragraphs(paragraphs)
    logger.info("Translating %d paragraphs in %d chunks", len(paragraphs), len(chunks))

    system = (
        "你是一位专业中英双语翻译。请将以下英文段落逐段翻译为中文。"
        "保留专业术语、人名、公司名的英文原文。"
        "严格按照 JSON 数组格式输出，不要添加任何额外文字。"
    )

    all_sections = []
    for i, chunk in enumerate(chunks):
        numbered = "\n\n".join(f"[{j+1}] {p}" for j, p in enumerate(chunk))
        user = f"""请将以下 {len(chunk)} 个英文段落逐段翻译为中文，输出 JSON 数组：

[
  {{"en": "原文段落1", "zh": "翻译段落1"}},
  {{"en": "原文段落2", "zh": "翻译段落2"}}
]

段落内容：
{numbered}"""

        logger.info("Translating chunk %d/%d (%d paragraphs)...", i + 1, len(chunks), len(chunk))
        raw = _llm_call(system, user)
        try:
            sections = _parse_json(raw)
            all_sections.extend(sections)
        except json.JSONDecodeError:
            logger.error("Failed to parse translation JSON for chunk %d, using raw text", i + 1)
            for p in chunk:
                all_sections.append({"en": p, "zh": "[翻译解析失败]"})

    return all_sections
