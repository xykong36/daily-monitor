#!/usr/bin/env python3
"""Generate weekly aggregate report from daily raw data files."""

import json
import logging
import sys
from datetime import datetime, timedelta
from pathlib import Path

from config import DATA_DIR, LOGS_DIR
from src.report import generate_report

log_file = LOGS_DIR / f"weekly_{datetime.now():%Y%m%d_%H%M%S}.log"
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(log_file, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("bili-weekly")


def collect_week_data(days: int = 7) -> dict | None:
    """Merge all raw_*.json files from the past N days into one dataset."""
    cutoff = datetime.now() - timedelta(days=days)
    raw_files = sorted(DATA_DIR.glob("raw_*.json"))

    selected = []
    for f in raw_files:
        # Parse timestamp from filename: raw_20260220_110507.json
        stem = f.stem  # raw_20260220_110507
        try:
            ts_str = stem.replace("raw_", "")
            file_dt = datetime.strptime(ts_str, "%Y%m%d_%H%M%S")
        except ValueError:
            continue
        if file_dt >= cutoff:
            selected.append(f)

    if not selected:
        logger.warning("No raw data files found in the past %d days", days)
        return None

    logger.info("Found %d raw files from past %d days", len(selected), days)

    # Merge: dedup videos by bvid, keep latest filter result
    all_videos: dict[str, dict] = {}  # bvid -> video dict
    all_filters: dict[str, dict] = {}  # bvid -> filter result

    for f in selected:
        with open(f, encoding="utf-8") as fh:
            data = json.load(fh)

        filter_map = {r.get("bvid"): r for r in data.get("ai_filter_results", []) if r.get("bvid")}

        for v in data.get("videos", []):
            bvid = v.get("bvid")
            if not bvid:
                continue
            # Keep the version with more data (higher view count = fresher)
            if bvid not in all_videos or v.get("view", 0) >= all_videos[bvid].get("view", 0):
                all_videos[bvid] = v
            if bvid in filter_map:
                all_filters[bvid] = filter_map[bvid]

    # Rebuild indexed structure
    videos = list(all_videos.values())
    videos.sort(key=lambda v: v.get("view", 0), reverse=True)

    filter_results = []
    for i, v in enumerate(videos):
        bvid = v.get("bvid")
        if bvid in all_filters:
            fr = {**all_filters[bvid], "index": i}
            filter_results.append(fr)
        else:
            filter_results.append({
                "index": i,
                "bvid": bvid,
                "title": v.get("title", ""),
                "owner": v.get("owner_name", ""),
                "tname": v.get("tname", ""),
                "source": v.get("source", ""),
                "view": v.get("view", 0),
                "like": v.get("like", 0),
                "include": None,
                "note": "AI filter did not return result for this video",
            })

    today = datetime.now().strftime("%Y%m%d")
    week_ago = cutoff.strftime("%Y%m%d")
    run_time = f"周报 {week_ago}-{today}"

    merged = {
        "run_time": run_time,
        "total_fetched": len(videos),
        "videos": videos,
        "ai_filter_results": filter_results,
    }
    return merged


def main() -> None:
    logger.info("=== Weekly report generation started ===")

    merged = collect_week_data(days=7)
    if not merged:
        return

    # Save merged JSON
    today = datetime.now().strftime("%Y%m%d")
    merged_path = DATA_DIR / f"weekly_{today}.json"
    merged_path.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("Weekly data saved: %s (%d videos)", merged_path, merged["total_fetched"])

    # Generate HTML report
    report_path = generate_report(str(merged_path))
    logger.info("Weekly HTML report: %s", report_path)

    logger.info("=== Weekly report complete ===")


if __name__ == "__main__":
    main()
