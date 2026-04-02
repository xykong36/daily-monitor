import sqlite3
import logging
from datetime import datetime, timezone

import config

logger = logging.getLogger(__name__)


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(config.DB_PATH))
    conn.execute(
        """CREATE TABLE IF NOT EXISTS processed (
            link TEXT PRIMARY KEY,
            title TEXT,
            processed_at TEXT,
            report_path TEXT
        )"""
    )
    return conn


def is_processed(link: str) -> bool:
    conn = _get_conn()
    try:
        row = conn.execute("SELECT 1 FROM processed WHERE link = ?", (link,)).fetchone()
        return row is not None
    finally:
        conn.close()


def mark_processed(link: str, title: str, report_path: str):
    conn = _get_conn()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO processed (link, title, processed_at, report_path) VALUES (?, ?, ?, ?)",
            (link, title, datetime.now(timezone.utc).isoformat(), report_path),
        )
        conn.commit()
        logger.info("Marked as processed: %s", title)
    finally:
        conn.close()


def filter_new(articles: list) -> list:
    """Return only articles not yet processed."""
    conn = _get_conn()
    try:
        new = []
        for a in articles:
            row = conn.execute("SELECT 1 FROM processed WHERE link = ?", (a.link,)).fetchone()
            if row is None:
                new.append(a)
        logger.info("Filtered: %d new out of %d total", len(new), len(articles))
        return new
    finally:
        conn.close()
