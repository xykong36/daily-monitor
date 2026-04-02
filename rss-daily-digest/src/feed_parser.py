import logging
from bs4 import BeautifulSoup
import feedparser
import httpx

from src.models import Article
import config

logger = logging.getLogger(__name__)


def fetch_feed(url: str = config.RSS_FEED_URL) -> list[Article]:
    """Parse RSS feed and return list of Article objects."""
    logger.info("Fetching RSS feed: %s", url)
    feed = feedparser.parse(url)

    if feed.bozo:
        logger.warning("Feed parse warning: %s", feed.bozo_exception)

    articles = []
    for entry in feed.entries:
        content_html = ""
        if hasattr(entry, "content") and entry.content:
            content_html = entry.content[0].value
        elif hasattr(entry, "summary"):
            content_html = entry.summary

        article = Article(
            title=entry.get("title", ""),
            link=entry.get("link", ""),
            author=entry.get("author", ""),
            pub_date=entry.get("published", ""),
            description=entry.get("summary", ""),
            content_html=content_html,
        )

        # If content is missing or too short, try fetching the page directly
        if len(article.content_html) < config.MIN_CONTENT_CHARS:
            logger.info("Content too short for '%s', fetching page directly", article.title)
            article.content_html = _fetch_page_content(article.link)

        _extract_text(article)

        if len(article.content_text) < config.MIN_CONTENT_CHARS:
            logger.warning("Skipping '%s': content too short (%d chars)", article.title, len(article.content_text))
            continue

        articles.append(article)

    logger.info("Fetched %d articles from feed", len(articles))
    return articles


def _fetch_page_content(url: str) -> str:
    """Fallback: fetch full page HTML via httpx."""
    try:
        resp = httpx.get(url, timeout=30, follow_redirects=True)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        # Try common article containers
        for selector in ["article", ".post-content", ".entry-content", "main"]:
            el = soup.select_one(selector)
            if el:
                return str(el)
        return resp.text
    except Exception as e:
        logger.error("Failed to fetch page %s: %s", url, e)
        return ""


def _extract_text(article: Article):
    """Clean HTML and extract plain text paragraphs."""
    soup = BeautifulSoup(article.content_html, "html.parser")

    # Remove unwanted tags
    for tag in soup.find_all(["script", "style", "iframe", "nav", "footer", "header"]):
        tag.decompose()

    # Extract text by paragraphs
    paragraphs = []
    for p in soup.find_all(["p", "h1", "h2", "h3", "h4", "li", "blockquote"]):
        text = p.get_text(strip=True)
        if text:
            paragraphs.append(text)

    # Fallback: use all text if no paragraphs found
    if not paragraphs:
        text = soup.get_text(separator="\n", strip=True)
        paragraphs = [line.strip() for line in text.split("\n") if line.strip()]

    article.paragraphs = paragraphs
    article.content_text = "\n\n".join(paragraphs)
