"""SearXNG factual search client with circuit breaker and injection-safe snippet sanitization."""

from __future__ import annotations

import html
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx
from dotenv import load_dotenv

# Circuit breaker state: timestamp until which the circuit remains open
_circuit_open_until: float = 0.0


def reset_searxng_circuit() -> None:
    """Reset the circuit breaker (used in tests and health checks)."""
    global _circuit_open_until
    _circuit_open_until = 0.0


def is_searxng_circuit_open() -> bool:
    """Check if the circuit breaker is currently open."""
    global _circuit_open_until
    return time.time() < _circuit_open_until


def get_searxng_config() -> Tuple[str, bool]:
    """Retrieve SEARXNG_URL and SEARXNG_ENABLED from environment or backend/.env."""
    url = os.getenv("SEARXNG_URL", "http://127.0.0.1:8080").strip().rstrip("/")
    enabled_str = os.getenv("SEARXNG_ENABLED", "true").strip().lower()
    enabled = enabled_str in ("true", "1", "yes", "on")
    return url, enabled


def is_factual_question(subject: str, q_type: str, question: str, options: List[str]) -> bool:
    """
    Determine if a question is factual and could benefit from search grounding.
    Returns False for pure math/arithmetic or code-tracing questions.
    Returns True for factual/conceptual questions (biology, history, geography, science, literature, etc.).
    """
    sub_lower = subject.strip().lower()
    q_lower = question.strip().lower()
    full_text = f"{sub_lower} {q_lower} {' '.join(options).lower()}"

    # 1. Pure math / arithmetic check
    # Check for pure arithmetic expressions like "48 * 19", "125 + 342", "Solve 5x = 20"
    math_patterns = [
        r"\b\d+\s*[\+\-\*\/\^]\s*\d+\b",
        r"\bwhat\s+is\s+\d+\s*[\+\-\*\/]",
        r"\bcalculate\s+\d+",
        r"\bevaluate\s+[\d\(]",
        r"\bsolve\s+for\s+[a-z]\b",
        r"\bderivative\s+of\b",
        r"\bintegral\s+of\b",
        r"\bsimplify\s+the\s+expression\b",
    ]
    for pattern in math_patterns:
        if re.search(pattern, q_lower):
            return False

    math_subjects = {"math", "mathematics", "arithmetic", "algebra", "calculus", "geometry", "trigonometry"}
    if sub_lower in math_subjects:
        # Check if it asks for a calculation or equation
        if any(op in q_lower for op in ["+", "-", "*", "/", "=", "^", "sqrt", "cos(", "sin(", "tan("]):
            return False

    # 2. Code tracing / programming syntax check
    code_patterns = [
        r"\bdef\s+\w+\s*\(",
        r"\bfunction\s*\w*\s*\(",
        r"\bconsole\.log\(",
        r"\bprint\s*\(",
        r"\bfor\s*\(\s*(var|let|int)\s+",
        r"\bwhat\s+(is\s+the\s+)?output\s+of\s+(this\s+)?code\b",
        r"\boutput\s+of\s+the\s+following\s+code\b",
        r"```[a-z]*",
    ]
    for pattern in code_patterns:
        if re.search(pattern, full_text):
            return False

    return True


def build_search_query(
    subject: str,
    q_type: str,
    question: str,
    options: List[str],
    candidate_answers: Optional[List[str]] = None,
) -> str:
    """
    Build a concise, contrastive search query (<= 160 chars) combining subject,
    salient question terms, and candidate answers (when resolving disagreements).
    """
    clean_q = re.sub(r"[\r\n\t]+", " ", question).strip()
    clean_q = re.sub(r"[?!:;\"']+", "", clean_q)
    # Remove common conversational filler
    clean_q = re.sub(r"^(which of the following|what is the|who was the|in what year did)\s+", "", clean_q, flags=re.IGNORECASE)

    parts: List[str] = []
    sub = subject.strip()
    if sub and sub.lower() not in ("general", "quiz", "unknown"):
        parts.append(sub)

    parts.append(clean_q)

    # If competing candidate answers are provided, append them for contrastive disambiguation
    if candidate_answers:
        candidates_clean = [re.sub(r"[^\w\s-]", "", str(c)).strip() for c in candidate_answers if str(c).strip()]
        if candidates_clean:
            # Use candidate terms
            parts.append(" ".join(candidates_clean[:3]))

    query = " ".join(parts).strip()
    query = re.sub(r"\s+", " ", query)

    # Bound to <= 160 characters
    if len(query) > 160:
        query = query[:160].rsplit(" ", 1)[0]

    return query


def strip_html_tags(text: str) -> str:
    """Strip HTML tags, unescape entities, and clean whitespace."""
    if not text:
        return ""
    clean = re.sub(r"<[^>]+>", " ", text)
    clean = html.unescape(clean)
    clean = re.sub(r"\s+([.,;:!?])", r"\1", clean)
    clean = re.sub(r"\s+", " ", clean).strip()
    return clean


async def fetch_searxng_snippets(
    client: httpx.AsyncClient,
    query: str,
    timeout_ms: int = 700,
    base_url: Optional[str] = None,
) -> List[Dict[str, str]]:
    """
    Query SearXNG JSON API for top 3 clean, truncated search snippets.
    Fails open instantly (< 5ms) if circuit breaker is open.
    Opens circuit for 60 seconds if connection fails.
    """
    global _circuit_open_until

    # Check circuit breaker
    if is_searxng_circuit_open():
        return []

    url_to_use, enabled = get_searxng_config()
    if base_url:
        url_to_use = base_url.rstrip("/")

    if not enabled:
        return []

    search_endpoint = f"{url_to_use}/search"
    timeout_sec = max(0.05, timeout_ms / 1000.0)

    try:
        response = await client.get(
            search_endpoint,
            params={
                "q": query,
                "format": "json",
                "language": "en",
            },
            timeout=timeout_sec,
        )

        if response.status_code != 200:
            return []

        data = response.json()
        raw_results = data.get("results", [])
        snippets: List[Dict[str, str]] = []

        for item in raw_results:
            content = item.get("content") or item.get("snippet") or ""
            title = item.get("title") or ""
            link = item.get("url") or ""

            # Sanitize snippet
            clean_title = strip_html_tags(title)
            clean_content = strip_html_tags(content)

            if clean_content:
                # Truncate content to 250 characters
                truncated_content = clean_content[:250].strip()
                snippets.append({
                    "title": clean_title[:80],
                    "content": truncated_content,
                    "url": link,
                })

            if len(snippets) >= 3:
                break

        return snippets

    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        # Trip circuit breaker for 60 seconds
        _circuit_open_until = time.time() + 60.0
        return []
    except (httpx.TimeoutException, httpx.HTTPError, Exception):
        # Transient timeout or error, fail open
        return []
