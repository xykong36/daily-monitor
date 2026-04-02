import logging
import re
from email.utils import parsedate_to_datetime
from pathlib import Path

from src.models import Article, AnalysisResult
import config

logger = logging.getLogger(__name__)


def _sanitize_filename(title: str) -> str:
    """Convert title to a safe filename."""
    s = title.lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s[:80].strip("-")


def generate_report(article: Article, result: AnalysisResult) -> str:
    """Generate a Markdown report and return the file path."""
    # Build filename — parse RFC 2822 date from RSS
    try:
        dt = parsedate_to_datetime(article.pub_date)
        date_part = dt.strftime("%Y-%m-%d")
    except Exception:
        date_part = "unknown"
    safe_title = _sanitize_filename(article.title)
    filename = f"{safe_title}_{date_part}.md"
    filepath = config.OUTPUT_DIR / filename

    # Build detailed outline section
    outline_md = ""
    for i, section in enumerate(result.detailed_outline, 1):
        heading = section.get("heading", "")
        summary = section.get("summary", "")
        key_points = section.get("key_points", [])
        outline_md += f"### {i}. {heading}\n{summary}\n"
        for pt in key_points:
            outline_md += f"- {pt}\n"
        outline_md += "\n"

    # Build key arguments section
    arguments_md = ""
    for i, arg in enumerate(result.key_arguments, 1):
        argument = arg.get("argument", "")
        evidence = arg.get("evidence", "")
        significance = arg.get("significance", "")
        arguments_md += f"### 论点 {i}: {argument}\n"
        arguments_md += f"**论据**: {evidence}\n\n"
        arguments_md += f"**意义**: {significance}\n\n"

    # Build keywords section
    keywords_md = ""
    for kw in result.keywords:
        term = kw.get("term", "")
        explanation = kw.get("explanation", "")
        keywords_md += f"- **{term}**: {explanation}\n"

    # Build devil's advocate section
    devil_md = ""
    for i, d in enumerate(result.devil_advocate, 1):
        devil_md += f"### {i}. {d.get('claim', '')}\n"
        devil_md += f"**反面论证**: {d.get('counter', '')}\n\n"
        devil_md += f"**来源**: {d.get('source', '')}\n\n"

    # Build bilingual appendix
    bilingual_md = ""
    for section in result.bilingual_sections:
        en = section.get("en", "")
        zh = section.get("zh", "")
        bilingual_md += f"> {en}\n\n{zh}\n\n"

    # Assemble full report
    report = f"""# {article.title}

> 原文: {article.link} | 作者: {article.author} | 日期: {article.pub_date}

## 📋 核心摘要

{result.outline_summary}

## 📑 详细大纲

{outline_md}
## 💡 核心论点与论据

{arguments_md}
## 🔑 关键词

{keywords_md}
## 🔗 逻辑链

{result.logic_chain}

## ⚖️ 对立面论证

{devil_md}
## 📊 综合评估

{result.overall_assessment}

---

## 📎 附录：中英对照全文（参考）

{bilingual_md}"""

    filepath.write_text(report, encoding="utf-8")
    logger.info("Report saved: %s", filepath)
    return str(filepath)
