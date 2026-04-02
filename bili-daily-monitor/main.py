#!/usr/bin/env python3
"""Bilibili Daily Monitor — main pipeline.

Flow: Fetch → Dedup → Subtitle → AI Filter → Save raw → Discord
"""

import json
import logging
import sys
from dataclasses import asdict
from datetime import datetime, timedelta

from config import DATA_DIR, LOGS_DIR
from src.ai_filter import filter_videos
from src.enrich import enrich_all
from src.fetchers.popular import fetch_popular
from src.fetchers.ranking import fetch_ranking
from src.fetchers.weekly import fetch_weekly
from src.models import DigestEntry, VideoItem
from src.notifier import send_digest, send_email
from src.report import generate_report
from src.store import SeenStore
from src.subtitle import extract_subtitle

# --- Logging setup ---
log_file = LOGS_DIR / f"run_{datetime.now():%Y%m%d_%H%M%S}.log"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(log_file, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("bili-monitor")


def dedup_by_bvid(videos: list[VideoItem]) -> list[VideoItem]:
    """Deduplicate videos by bvid, keeping first occurrence."""
    seen: set[str] = set()
    result: list[VideoItem] = []
    for v in videos:
        if v.bvid not in seen:
            seen.add(v.bvid)
            result.append(v)
    return result


def _save_raw_data(
    all_videos: list[VideoItem],
    filter_results: list[dict],
    run_ts: str,
) -> str:
    """Save all intermediate data to a JSON file for review."""
    raw_path = DATA_DIR / f"raw_{run_ts}.json"
    raw = {
        "run_time": run_ts,
        "total_fetched": len(all_videos),
        "videos": [asdict(v) for v in all_videos],
        "ai_filter_results": filter_results,
    }
    raw_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("Raw data saved to %s", raw_path)
    return str(raw_path)


def main() -> None:
    run_ts = f"{datetime.now():%Y%m%d_%H%M%S}"
    logger.info("=== Bilibili Daily Monitor started ===")

    # Step 1: Fetch from all sources
    all_videos: list[VideoItem] = []
    for name, fetcher in [("popular", fetch_popular), ("ranking", fetch_ranking), ("weekly", fetch_weekly)]:
        try:
            videos = fetcher()
            all_videos.extend(videos)
            logger.info("Fetched %d videos from %s", len(videos), name)
        except Exception as e:
            logger.error("Failed to fetch %s: %s", name, e)

    if not all_videos:
        logger.warning("No videos fetched, exiting")
        return

    # Step 2: Dedup by bvid
    unique_videos = dedup_by_bvid(all_videos)
    logger.info("After dedup: %d unique videos (from %d total)", len(unique_videos), len(all_videos))

    # Step 3: Filter out already-seen videos
    store = SeenStore()
    try:
        new_bvids = set(store.filter_new([v.bvid for v in unique_videos]))
        new_videos = [v for v in unique_videos if v.bvid in new_bvids]
        logger.info("After store filter: %d new videos", len(new_videos))

        if not new_videos:
            logger.info("No new videos to process, exiting")
            return

        # Mark all as seen immediately (so concurrent runs won't duplicate)
        for v in new_videos:
            store.mark_seen(v.bvid, v.title)

        # Step 4: Enrich with full metadata from detail API
        logger.info("Enriching %d videos with detail API...", len(new_videos))
        enrich_all(new_videos)

        # Step 4.5: Filter out videos older than 72 hours
        from datetime import timezone
        cutoff_ts = int((datetime.now(timezone.utc) - timedelta(hours=72)).timestamp())
        before_filter = len(new_videos)
        new_videos = [v for v in new_videos if v.pubdate >= cutoff_ts]
        logger.info("Date filter: kept %d/%d videos (pubdate >= %s)",
                    len(new_videos), before_filter,
                    datetime.fromtimestamp(cutoff_ts).strftime("%Y-%m-%d %H:%M"))
        if not new_videos:
            logger.info("No recent videos after date filter, exiting")
            return

        # Step 5: Extract subtitles (best-effort)
        for v in new_videos:
            try:
                v.subtitle_text = extract_subtitle(v)
                if v.subtitle_text:
                    logger.info("Subtitle extracted for %s (%d chars)", v.bvid, len(v.subtitle_text))
            except Exception as e:
                logger.debug("Subtitle extraction failed for %s: %s", v.bvid, e)

        # Step 6: AI filter (batch)
        filter_results = filter_videos(new_videos)

        # Build combined results for raw data export
        result_map = {r.index: r for r in filter_results}
        raw_filter_data = []
        for i, v in enumerate(new_videos):
            fr = result_map.get(i)
            entry = {
                "index": i,
                "bvid": v.bvid,
                "title": v.title,
                "owner": v.owner_name,
                "tname": v.tname,
                "source": v.source,
                "view": v.view,
                "like": v.like,
            }
            if fr:
                entry.update({
                    "include": fr.include,
                    "category": fr.category,
                    "score": fr.score,
                    "reason": fr.reason,
                    "topic_analysis": fr.topic_analysis,
                    "trending_reason": fr.trending_reason,
                    "summary": fr.summary,
                })
            else:
                entry["include"] = None
                entry["note"] = "AI filter did not return result for this video"
            raw_filter_data.append(entry)

        # Save ALL raw data (videos + filter results) + generate HTML report
        raw_file = _save_raw_data(new_videos, raw_filter_data, run_ts)
        report_path = generate_report(raw_file)
        logger.info("HTML report: %s", report_path)

        if not filter_results:
            logger.warning("AI filter returned no results")
            return

        # Build digest entries for included videos
        entries: list[DigestEntry] = []
        for i, v in enumerate(new_videos):
            fr = result_map.get(i)
            if fr and fr.include:
                entries.append(DigestEntry(video=v, filter_result=fr))

        entries.sort(key=lambda e: -e.filter_result.score)
        logger.info("AI selected %d videos for digest", len(entries))

        if not entries:
            logger.info("No videos passed AI filter")
            return

        # Step 6: Send to Discord + Email (independent, failures don't affect each other)
        try:
            discord_ok = send_digest(entries)
        except Exception as e:
            logger.error("Discord send crashed: %s", e)
            discord_ok = False

        try:
            email_ok = send_email(entries)
        except Exception as e:
            logger.error("Email send crashed: %s", e)
            email_ok = False

        logger.info("Notification results — Discord: %s, Email: %s", discord_ok, email_ok)

        for e in entries:
            store.mark_notified(e.video.bvid)

    finally:
        store.close()

    logger.info("=== Pipeline complete ===")


if __name__ == "__main__":
    main()
