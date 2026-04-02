#!/usr/bin/env python3
"""RSS Article Deep-Analysis Agent — CLI entry point."""

import argparse
import logging
import sys

import config
from src.models import AnalysisResult
from src.feed_parser import fetch_feed
from src.store import filter_new, mark_processed
from src.analyzer import run_analysis
from src.translator import translate_paragraphs
from src.report import generate_report
from src.notifier import send_discord

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(config.LOGS_DIR / "run.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)


def process_article(article, skip_translate=False):
    """Run the full analysis + translation + report pipeline for one article."""
    logger.info("=" * 60)
    logger.info("Processing: %s", article.title)
    logger.info("Link: %s", article.link)
    logger.info("Content length: %d chars, %d paragraphs", len(article.content_text), len(article.paragraphs))

    # Step 1: LLM Analysis (3 calls)
    analysis = run_analysis(article.content_text)

    # Step 2: Translation (N calls)
    bilingual = []
    if not skip_translate:
        logger.info("Starting translation...")
        bilingual = translate_paragraphs(article.paragraphs)
    else:
        logger.info("Skipping translation (--no-translate)")

    # Step 3: Build AnalysisResult
    result = AnalysisResult(
        outline_summary=analysis["outline_summary"],
        detailed_outline=analysis["detailed_outline"],
        key_arguments=analysis["key_arguments"],
        keywords=analysis["keywords"],
        logic_chain=analysis["logic_chain"],
        bilingual_sections=bilingual,
        devil_advocate=analysis["devil_advocate"],
        overall_assessment=analysis["overall_assessment"],
    )

    # Step 4: Generate Markdown report
    report_path = generate_report(article, result)

    # Step 5: Send Discord notification
    send_discord(article, result, report_path)

    # Step 6: Mark as processed
    mark_processed(article.link, article.title, report_path)

    logger.info("Done: %s → %s", article.title, report_path)
    return report_path


def main():
    parser = argparse.ArgumentParser(description="RSS Article Deep-Analysis Agent")
    parser.add_argument("--force", action="store_true", help="Force re-process all articles (ignore dedup)")
    parser.add_argument("--limit", type=int, default=0, help="Max articles to process (0 = all)")
    parser.add_argument("--no-translate", action="store_true", help="Skip translation step")
    parser.add_argument("--feed-url", type=str, default=config.RSS_FEED_URL, help="RSS feed URL")
    args = parser.parse_args()

    logger.info("Starting RSS Deep-Analysis Agent")
    logger.info("Feed URL: %s", args.feed_url)

    # Validate API key
    if not config.ZHIPUAI_API_KEY:
        logger.error("ZHIPUAI_API_KEY not set. Please configure .env file.")
        sys.exit(1)

    # Step 1: Fetch RSS feed
    articles = fetch_feed(args.feed_url)
    if not articles:
        logger.info("No articles found in feed.")
        return

    for a in articles:
        logger.info("  [%s] %s (%d chars)", a.pub_date[:10] if len(a.pub_date) >= 10 else "?", a.title, len(a.content_text))

    # Step 2: Dedup filter
    if args.force:
        logger.info("Force mode: processing all %d articles", len(articles))
        new_articles = articles
    else:
        new_articles = filter_new(articles)

    if not new_articles:
        logger.info("0 new articles to process. All articles already processed.")
        return

    logger.info("%d new article(s) to process", len(new_articles))

    # Apply limit
    if args.limit > 0:
        new_articles = new_articles[: args.limit]
        logger.info("Limited to %d article(s)", len(new_articles))

    # Step 3: Process each article
    processed = 0
    failed = 0
    for article in new_articles:
        try:
            process_article(article, skip_translate=args.no_translate)
            processed += 1
        except Exception as e:
            logger.error("Failed to process '%s': %s", article.title, e, exc_info=True)
            failed += 1

    logger.info("=" * 60)
    logger.info("Complete: %d processed, %d failed, %d skipped (already processed)", processed, failed, len(articles) - len(new_articles))


if __name__ == "__main__":
    main()
