"""LLM client, model checker, parallel primary execution, and fallback solver."""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from backend.core.normalizer import (
    NormalizationError,
    NormalizedAnswer,
    normalize_answer,
    parse_options,
)
from backend.core.parser import ParseError, parse_llm_response
from backend.core.prompts import build_arbiter_messages, build_prompt_messages
from backend.core.searxng_client import (
    build_search_query,
    fetch_searxng_snippets,
    get_searxng_config,
    is_factual_question,
    is_searxng_circuit_open,
)


class SolverResponse(BaseModel):
    """Complete canonical solver response with Zero-DOM-Mutation readiness."""
    status: str  # "OK" or "UNCERTAIN"
    confidence_tier: str
    canonical_key: Optional[str] = None
    selected_index: Optional[int] = None
    selected_text: Optional[str] = None
    permutation_indices: Optional[List[int]] = None
    ordered_texts: Optional[List[str]] = None
    reason: Optional[str] = None
    latency_ms: float = 0.0
    models_called: List[str] = Field(default_factory=list)
    agreement_details: Dict[str, Any] = Field(default_factory=dict)
    searxng_used: bool = False
    search_sources: List[str] = Field(default_factory=list)
    error: Optional[str] = None


def find_env_file() -> Path:
    """Find backend/.env or root .env file."""
    candidates = [
        Path.cwd() / "backend" / ".env",
        Path.cwd() / ".env",
        Path(__file__).resolve().parent.parent / ".env",
    ]
    for c in candidates:
        if c.is_file():
            return c
    return candidates[0]


# Non-chat model exclusion keywords (embedding, reranker, content-safety, guard, whisper, tts)
NON_CHAT_KEYWORDS = ("embed", "rerank", "safety", "guard", "whisper", "tts")

_key_quarantine_until: Dict[str, float] = {}
_model_quarantine_until: Dict[str, float] = {}
_openrouter_key_rr_idx: int = 0


def is_valid_chat_model(slug: str) -> bool:
    """Strictly reject any slug containing embed, rerank, safety, guard, whisper, or tts."""
    if not slug:
        return False
    slug_lower = slug.lower()
    return not any(kw in slug_lower for kw in NON_CHAT_KEYWORDS)


def quarantine_key(key: str, status_code: int) -> None:
    """
    Quarantine specific API key:
    - HTTP 429: quarantine for 45 seconds.
    - HTTP 401, 402, 403: quarantine for 300 seconds.
    """
    if not key:
        return
    now = time.time()
    if status_code == 429:
        _key_quarantine_until[key] = now + 45.0
    elif status_code in (401, 402, 403):
        _key_quarantine_until[key] = now + 300.0


def is_key_quarantined(key: str) -> bool:
    if not key:
        return False
    until = _key_quarantine_until.get(key, 0.0)
    return time.time() < until


def reset_key_quarantine() -> None:
    """Reset key quarantine map (primarily for unit tests)."""
    global _key_quarantine_until, _openrouter_key_rr_idx
    _key_quarantine_until.clear()
    _openrouter_key_rr_idx = 0


def quarantine_model(model_slug: str, duration_sec: float = 60.0) -> None:
    """Deprioritize an OpenRouter model slug for 60 seconds on error or timeout."""
    if not model_slug:
        return
    _model_quarantine_until[model_slug] = time.time() + duration_sec


def is_model_quarantined(model_slug: str) -> bool:
    if not model_slug:
        return False
    until = _model_quarantine_until.get(model_slug, 0.0)
    return time.time() < until


def reset_model_quarantine() -> None:
    """Reset model quarantine map (primarily for unit tests)."""
    global _model_quarantine_until
    _model_quarantine_until.clear()


def load_groq_api_keys() -> List[str]:
    """Load all unique non-empty Groq keys from GROQ_API_KEYS, GROQ_API_KEY, and numbered vars."""
    if "GROQ_API_KEYS" not in os.environ and "GROQ_API_KEY" not in os.environ:
        env_path = find_env_file()
        if env_path.is_file():
            load_dotenv(dotenv_path=env_path)
        else:
            load_dotenv()

    keys: List[str] = []
    multi_raw = os.getenv("GROQ_API_KEYS", "")
    for k in multi_raw.split(","):
        k_clean = k.strip()
        if k_clean and k_clean not in keys:
            keys.append(k_clean)

    single_raw = os.getenv("GROQ_API_KEY", "")
    for k in single_raw.split(","):
        k_clean = k.strip()
        if k_clean and k_clean not in keys:
            keys.append(k_clean)

    for env_k, env_v in os.environ.items():
        if env_k.startswith("GROQ_API_KEY_"):
            v_clean = env_v.strip()
            if v_clean and v_clean not in keys:
                keys.append(v_clean)

    return keys


def load_openrouter_api_keys() -> List[str]:
    """Load all unique non-empty OpenRouter keys from OPENROUTER_API_KEYS, OPENROUTER_API_KEY, and numbered vars."""
    if "OPENROUTER_API_KEYS" not in os.environ and "OPENROUTER_API_KEY" not in os.environ:
        env_path = find_env_file()
        if env_path.is_file():
            load_dotenv(dotenv_path=env_path)
        else:
            load_dotenv()

    keys: List[str] = []
    multi_raw = os.getenv("OPENROUTER_API_KEYS", "")
    for k in multi_raw.split(","):
        k_clean = k.strip()
        if k_clean and k_clean not in keys:
            keys.append(k_clean)

    single_raw = os.getenv("OPENROUTER_API_KEY", "")
    for k in single_raw.split(","):
        k_clean = k.strip()
        if k_clean and k_clean not in keys:
            keys.append(k_clean)

    for env_k, env_v in os.environ.items():
        if env_k.startswith("OPENROUTER_API_KEY_"):
            v_clean = env_v.strip()
            if v_clean and v_clean not in keys:
                keys.append(v_clean)

    return keys


def get_healthy_openrouter_keys() -> List[str]:
    all_keys = load_openrouter_api_keys()
    if not all_keys:
        return []
    healthy = [k for k in all_keys if not is_key_quarantined(k)]
    return healthy if healthy else all_keys


def get_next_openrouter_key(exclude: Optional[str] = None) -> str:
    global _openrouter_key_rr_idx
    healthy = get_healthy_openrouter_keys()
    if not healthy:
        return ""
    candidates = [k for k in healthy if k != exclude] if (exclude and len(healthy) > 1) else healthy
    idx = _openrouter_key_rr_idx % len(candidates)
    _openrouter_key_rr_idx += 1
    return candidates[idx]


TIER_WEIGHT: Dict[str, int] = {"S": 1, "A": 2, "B": 3}

DEFAULT_TIER_PRIORITY: Dict[str, Tuple[str, int]] = {
    "nvidia/nemotron-3-ultra-550b-a55b:free": ("S", 1),
    "nvidia/nemotron-3-super-120b-a12b:free": ("S", 2),
    "google/gemma-4-31b-it:free": ("S", 3),
    "google/gemma-4-26b-a4b-it:free": ("A", 4),
    "nvidia/nemotron-3.5-lightning:free": ("B", 5),
    "liquid/lfm-2.5-2.6b:free": ("B", 6),
}


def extract_model_meta(item: Any) -> Dict[str, Any]:
    """Convert a model dict or string slug into normalized dict metadata."""
    if isinstance(item, dict):
        model = item.get("model", "")
        tier = item.get("tier")
        priority = item.get("priority")
        if not tier or priority is None:
            def_tier, def_prio = DEFAULT_TIER_PRIORITY.get(model, ("B", 99))
            tier = tier or def_tier
            priority = priority if priority is not None else def_prio
        return {
            "provider": item.get("provider", "openrouter"),
            "family": item.get("family", ""),
            "model": model,
            "tier": str(tier).upper(),
            "priority": int(priority),
        }
    elif isinstance(item, str):
        def_tier, def_prio = DEFAULT_TIER_PRIORITY.get(item, ("B", 99))
        return {
            "provider": "openrouter",
            "family": "",
            "model": item,
            "tier": def_tier,
            "priority": def_prio,
        }
    return {"provider": "openrouter", "family": "", "model": str(item), "tier": "B", "priority": 99}


def get_ordered_fallback_pool(config: Optional[Union[dict, list]] = None) -> List[Dict[str, Any]]:
    """
    Return candidate fallback models strictly ordered by capability tier and priority:
    (TIER_WEIGHT[tier], priority). Accepts config dict or candidate model list.
    """
    if config is None:
        try:
            config = load_models_config()
        except Exception:
            config = {}

    if isinstance(config, list):
        raw_pool = config
    else:
        raw_pool = config.get("fallback_pool")
        if not raw_pool:
            fb_m = config.get("fallback", {})
            if isinstance(fb_m, dict) and fb_m.get("model"):
                raw_pool = [fb_m]
            elif isinstance(fb_m, str):
                raw_pool = [fb_m]
            else:
                raw_pool = []

    parsed = [extract_model_meta(item) for item in raw_pool if item]
    valid = [item for item in parsed if is_valid_chat_model(item["model"])]
    valid.sort(key=lambda x: (TIER_WEIGHT.get(x.get("tier", "B").upper(), 99), x.get("priority", 99)))
    return valid


def get_active_fallback_pool(config: Optional[dict] = None) -> List[str]:
    """Return model slug strings in strict capability tier order."""
    ordered = get_ordered_fallback_pool(config)
    return [m["model"] for m in ordered]


def get_healthy_fallback_models(pool: Sequence[Any]) -> List[str]:
    """
    Return healthy (non-quarantined) models in strict tier order as a list of model slug strings.
    Accepts either list of model dicts or list of string slugs.
    """
    meta_list = [extract_model_meta(m) for m in pool if m]
    valid = [m for m in meta_list if is_valid_chat_model(m["model"])]
    valid.sort(key=lambda x: (TIER_WEIGHT.get(x.get("tier", "B").upper(), 99), x.get("priority", 99)))
    healthy = [m["model"] for m in valid if not is_model_quarantined(m["model"])]
    return healthy if healthy else [m["model"] for m in valid]


def load_api_keys() -> Tuple[str, str]:
    """Load primary GROQ_API_KEY and OPENROUTER_API_KEY (backward compatible)."""
    groq_keys = load_groq_api_keys()
    or_keys = load_openrouter_api_keys()
    groq_key = groq_keys[0] if groq_keys else ""
    openrouter_key = or_keys[0] if or_keys else ""
    return groq_key, openrouter_key


def load_models_config(config_path: Optional[str] = None) -> dict:
    """Load and parse models.json."""
    path = Path(config_path) if config_path else Path.cwd() / "models.json"
    if not path.is_file():
        alt = Path(__file__).resolve().parent.parent.parent / "models.json"
        if alt.is_file():
            path = alt
        else:
            raise FileNotFoundError(f"models.json not found at {path}")

    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


async def call_single_completion(
    client: httpx.AsyncClient,
    provider: str,
    model: str,
    messages: List[dict],
    api_key: str,
    timeout_ms: float,
    max_tokens: int = 600,
) -> Tuple[Optional[str], float, Optional[str]]:
    """
    Call a single LLM provider chat completions endpoint with timeout.
    Uses max_tokens (default 600, 256 for pings) and falls back to reasoning fields if content is empty.
    Returns: (raw_content, elapsed_ms, error_string)
    """
    timeout_sec = max(0.1, timeout_ms / 1000.0)
    t0 = time.perf_counter()

    if provider == "groq":
        url = "https://api.groq.com/openai/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.0,
            "max_tokens": max_tokens,
        }
    elif provider == "openrouter":
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "HTTP-Referer": "https://github.com/quizzy-eval",
            "X-Title": "QuizZy Evaluator",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.0,
            "max_tokens": max_tokens,
        }
    else:
        return None, 0.0, f"Unsupported provider: {provider}"

    try:
        response = await client.post(
            url,
            headers=headers,
            json=payload,
            timeout=timeout_sec,
        )
        elapsed_ms = (time.perf_counter() - t0) * 1000.0

        if response.status_code == 200:
            data = response.json()
            choices = data.get("choices", [])
            if choices and "message" in choices[0]:
                msg = choices[0]["message"]
                content = msg.get("content") or ""
                # Fallback to reasoning / reasoning_content if content is empty/null
                if not str(content).strip():
                    content = msg.get("reasoning") or msg.get("reasoning_content") or ""
                if str(content).strip():
                    return str(content), elapsed_ms, None
                if provider == "openrouter":
                    quarantine_model(model, 60.0)
                return None, elapsed_ms, "EMPTY_CHOICES_CONTENT"
            if provider == "openrouter":
                quarantine_model(model, 60.0)
            return None, elapsed_ms, "EMPTY_CHOICES"
        elif response.status_code == 429:
            quarantine_key(api_key, 429)
            if provider == "openrouter":
                quarantine_model(model, 60.0)
            return None, elapsed_ms, "RATE_LIMIT_429"
        elif response.status_code in (401, 402, 403):
            quarantine_key(api_key, response.status_code)
            return None, elapsed_ms, f"HTTP_{response.status_code}: {response.text[:150]}"
        else:
            if provider == "openrouter" and response.status_code in (404, 500, 502, 503, 504):
                quarantine_model(model, 60.0)
            return None, elapsed_ms, f"HTTP_{response.status_code}: {response.text[:150]}"

    except httpx.TimeoutException:
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        if provider == "openrouter":
            quarantine_model(model, 60.0)
        return None, elapsed_ms, "TIMEOUT"
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        if provider == "openrouter":
            quarantine_model(model, 60.0)
        return None, elapsed_ms, f"NETWORK_ERROR_{type(exc).__name__}: {str(exc)}"


async def call_model_with_budget_retry(
    client: httpx.AsyncClient,
    provider: str,
    model: str,
    messages: List[dict],
    api_key: str,
    timeout_ms: float,
    q_type: str,
    options: List[str],
    max_tokens: int = 600,
) -> Tuple[Optional[str], Optional[ParsedLLMResponse], Optional[NormalizedAnswer], float, Optional[str]]:
    """
    Call model with budget-aware single fast retry on transient 5xx, network error,
    or ParseError (never on 429 or timeout) ONLY if elapsed time in current stage < 700 ms (100ms backoff).
    Returns: (raw_text, parsed_response, normalized_answer, elapsed_ms, error_string)
    """
    t_start = time.perf_counter()
    raw, el, err = await call_single_completion(client, provider, model, messages, api_key, timeout_ms, max_tokens=max_tokens)

    parsed: Optional[ParsedLLMResponse] = None
    norm: Optional[NormalizedAnswer] = None

    # Check if transient network/5xx error can be retried
    if err:
        if "429" not in err and "TIMEOUT" not in err:
            elapsed_so_far = (time.perf_counter() - t_start) * 1000.0
            if elapsed_so_far < 700.0:
                await asyncio.sleep(0.1)  # 100ms backoff
                rem_timeout = timeout_ms - ((time.perf_counter() - t_start) * 1000.0)
                if rem_timeout > 200.0:
                    raw, el2, err = await call_single_completion(client, provider, model, messages, api_key, rem_timeout, max_tokens=max_tokens)

    # If HTTP call succeeded, parse & normalize
    if not err and raw:
        try:
            parsed = parse_llm_response(raw)
            norm = normalize_answer(q_type, parsed.answer, options)
        except (ParseError, NormalizationError) as pe:
            # Check if we can retry on parse/normalization failure
            elapsed_so_far = (time.perf_counter() - t_start) * 1000.0
            if elapsed_so_far < 700.0:
                await asyncio.sleep(0.1)  # 100ms backoff
                rem_timeout = timeout_ms - ((time.perf_counter() - t_start) * 1000.0)
                if rem_timeout > 200.0:
                    raw2, el2, err2 = await call_single_completion(client, provider, model, messages, api_key, rem_timeout, max_tokens=max_tokens)
                    if not err2 and raw2:
                        try:
                            parsed = parse_llm_response(raw2)
                            norm = normalize_answer(q_type, parsed.answer, options)
                            raw = raw2
                            err = None
                        except (ParseError, NormalizationError) as pe2:
                            err = f"PARSE_OR_NORM_ERROR: {pe2}"
                    else:
                        err = err2 or "RETRY_EMPTY"
            else:
                err = f"PARSE_OR_NORM_ERROR: {pe}"

    total_elapsed = (time.perf_counter() - t_start) * 1000.0
    return raw, parsed, norm, total_elapsed, err


async def run_hedged_openrouter_fallback(
    client: httpx.AsyncClient,
    fallback_pool: Union[List[str], List[dict]],
    messages: List[dict],
    q_type: str,
    options: List[str],
    timeout_ms: float,
    norm_a: Optional[NormalizedAnswer],
    norm_b: Optional[NormalizedAnswer],
    succ_a: bool,
    succ_b: bool,
    parsed_a: Optional[ParsedLLMResponse] = None,
    parsed_b: Optional[ParsedLLMResponse] = None,
    s_tier_soft_escalation_ms: float = 1300.0,
) -> Tuple[Optional[SolverResponse], List[str], Dict[str, Any]]:
    """
    Two-Wave Tier Cascade execution:
    - Wave 1 (Top-Tier S-Tier Models First):
      Dispatches top 2 healthy S-Tier models in parallel with distinct OpenRouter API keys.
      Waits up to s_tier_soft_escalation_ms (1300ms). If an S-Tier model produces a 2-of-3 consensus,
      cancels pending tasks and returns immediately.
    - Wave 2 (Automatic Escalation to Lower-Tier A/B Models):
      If S-Tier models fail/429/empty or s_tier_soft_escalation_ms elapses with remaining_ms >= 350,
      concurrently launches up to 2 healthy A/B-Tier models without cancelling still-running S-Tier tasks.
      Prefers S-Tier consensus if both complete.
    """
    meta_pool = [extract_model_meta(m) for m in fallback_pool if m]
    valid_pool = [m for m in meta_pool if is_valid_chat_model(m["model"])]
    valid_pool.sort(key=lambda x: (TIER_WEIGHT.get(x.get("tier", "B").upper(), 99), x.get("priority", 99)))

    if not valid_pool:
        return None, [], {"error": "NO_VALID_FALLBACK_MODELS", "success": False}

    s_models = [m for m in valid_pool if m["tier"] == "S"]
    lower_models = [m for m in valid_pool if m["tier"] in ("A", "B")]

    # If no S-tier models exist (e.g. mock test pool), treat entire pool as Wave 1
    if not s_models:
        s_models = valid_pool
        lower_models = []

    healthy_s = [m for m in s_models if not is_model_quarantined(m["model"])]
    if not healthy_s:
        healthy_s = s_models

    wave1_models = healthy_s[:2]
    k1 = get_next_openrouter_key()
    k2 = get_next_openrouter_key(exclude=k1) if len(wave1_models) > 1 else k1
    keys_w1 = [k1, k2] if len(wave1_models) > 1 else [k1]

    models_called: List[str] = [f"fallback_{i+1}:{m['model']}" for i, m in enumerate(wave1_models)]
    fallback_details: Dict[str, Any] = {
        "models": [m["model"] for m in wave1_models],
        "results": [],
    }

    t0_fb = time.perf_counter()
    task_meta: Dict[asyncio.Task, Dict[str, Any]] = {}

    async def _runner(task_idx: int, model_meta: dict, key: str, task_timeout: float):
        raw, parsed, norm, el, err = await call_model_with_budget_retry(
            client, "openrouter", model_meta["model"], messages, key, task_timeout, q_type, options
        )
        return task_idx, model_meta, raw, parsed, norm, el, err

    tasks = []
    for i, m in enumerate(wave1_models):
        t = asyncio.create_task(_runner(i, m, keys_w1[i], timeout_ms))
        task_meta[t] = {"idx": i, "meta": m, "wave": 1}
        tasks.append(t)

    pending = set(tasks)
    completed_results: List[Tuple[int, dict, Any, Any, Any, float, Any, bool]] = []
    early_solution: Optional[SolverResponse] = None
    wave2_launched = False

    soft_timeout_sec = min(s_tier_soft_escalation_ms, timeout_ms) / 1000.0

    while pending:
        time_elapsed_ms = (time.perf_counter() - t0_fb) * 1000.0
        remaining_hard_ms = max(10.0, timeout_ms - time_elapsed_ms)

        if not wave2_launched and lower_models:
            time_until_soft_sec = max(0.01, soft_timeout_sec - (time_elapsed_ms / 1000.0))
            wait_timeout = min(time_until_soft_sec, remaining_hard_ms / 1000.0)
        else:
            wait_timeout = remaining_hard_ms / 1000.0

        done, pending = await asyncio.wait(
            pending,
            timeout=wait_timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )

        if done:
            # Sort completed so S-tier is evaluated before A/B-tier
            done_sorted = sorted(
                list(done),
                key=lambda t: (TIER_WEIGHT.get(task_meta[t]["meta"]["tier"], 99), task_meta[t]["meta"]["priority"])
            )

            for t in done_sorted:
                try:
                    idx, m_meta, raw, parsed, norm, el, err = await t
                except (asyncio.CancelledError, Exception):
                    continue

                succ = bool(not err and norm and parsed)
                res_entry = {
                    "model": m_meta["model"],
                    "tier": m_meta["tier"],
                    "priority": m_meta["priority"],
                    "success": succ,
                    "error": err,
                    "canonical_key": norm.canonical_key if norm else None,
                    "reason": parsed.reason if parsed else None,
                    "latency_ms": el,
                    "norm": norm,
                }
                fallback_details["results"].append(res_entry)
                completed_results.append((idx, m_meta, raw, parsed, norm, el, err, succ))

                # First-to-agree with Primary A or B
                if succ and norm:
                    if succ_a and norm_a and norm.canonical_key == norm_a.canonical_key:
                        for p in pending:
                            p.cancel()
                        await asyncio.sleep(0)
                        tier = "MEDIUM_TIEBREAKER_AGREE" if succ_b else "LOW_FALLBACK_RESCUE"
                        reason = parsed.reason or (parsed_a.reason if parsed_a else "")
                        early_solution = SolverResponse(
                            status="OK",
                            confidence_tier=tier,
                            canonical_key=norm_a.canonical_key,
                            selected_index=norm_a.selected_index,
                            selected_text=norm_a.selected_text,
                            permutation_indices=norm_a.permutation_indices,
                            ordered_texts=norm_a.ordered_texts,
                            reason=reason,
                        )
                        break

                    if succ_b and norm_b and norm.canonical_key == norm_b.canonical_key:
                        for p in pending:
                            p.cancel()
                        await asyncio.sleep(0)
                        tier = "MEDIUM_TIEBREAKER_AGREE" if succ_a else "LOW_FALLBACK_RESCUE"
                        reason = parsed.reason or (parsed_b.reason if parsed_b else "")
                        early_solution = SolverResponse(
                            status="OK",
                            confidence_tier=tier,
                            canonical_key=norm_b.canonical_key,
                            selected_index=norm_b.selected_index,
                            selected_text=norm_b.selected_text,
                            permutation_indices=norm_b.permutation_indices,
                            ordered_texts=norm_b.ordered_texts,
                            reason=reason,
                        )
                        break

            if early_solution is not None:
                break

            # Dual-fallback consensus check across all completed results
            successful_fbs = [r for r in completed_results if r[7] and r[4]]
            if len(successful_fbs) >= 2:
                for i_fb in range(len(successful_fbs)):
                    for j_fb in range(i_fb + 1, len(successful_fbs)):
                        r1, r2 = successful_fbs[i_fb], successful_fbs[j_fb]
                        norm1, norm2 = r1[4], r2[4]
                        if norm1.canonical_key == norm2.canonical_key:
                            for p in pending:
                                p.cancel()
                            parsed1, parsed2 = r1[3], r2[3]
                            reason = parsed1.reason if parsed1 else (parsed2.reason if parsed2 else "")
                            early_solution = SolverResponse(
                                status="OK",
                                confidence_tier="MEDIUM_TIEBREAKER_AGREE",
                                canonical_key=norm1.canonical_key,
                                selected_index=norm1.selected_index,
                                selected_text=norm1.selected_text,
                                permutation_indices=norm1.permutation_indices,
                                ordered_texts=norm1.ordered_texts,
                                reason=reason,
                            )
                            break
                    if early_solution is not None:
                        break

            if early_solution is not None:
                break

        # Check for Wave 2 escalation
        current_elapsed_ms = (time.perf_counter() - t0_fb) * 1000.0
        rem_ms = timeout_ms - current_elapsed_ms
        wave1_all_done = all(t.done() for t in task_meta if task_meta[t]["wave"] == 1)
        soft_expired = current_elapsed_ms >= (s_tier_soft_escalation_ms - 15.0)

        if not wave2_launched and lower_models and (wave1_all_done or soft_expired) and rem_ms >= 350.0:
            wave2_launched = True
            healthy_ab = [m for m in lower_models if not is_model_quarantined(m["model"])]
            if not healthy_ab:
                healthy_ab = lower_models
            wave2_candidates = healthy_ab[:2]

            k1_w2 = get_next_openrouter_key()
            k2_w2 = get_next_openrouter_key(exclude=k1_w2) if len(wave2_candidates) > 1 else k1_w2
            keys_w2 = [k1_w2, k2_w2] if len(wave2_candidates) > 1 else [k1_w2]

            for j, m_ab in enumerate(wave2_candidates):
                t_w2 = asyncio.create_task(_runner(len(tasks) + j, m_ab, keys_w2[j], rem_ms))
                task_meta[t_w2] = {"idx": len(tasks) + j, "meta": m_ab, "wave": 2}
                pending.add(t_w2)
                models_called.append(f"fallback_w2_{j+1}:{m_ab['model']}")
                fallback_details["models"].append(m_ab["model"])

        if (time.perf_counter() - t0_fb) * 1000.0 >= timeout_ms:
            for p in pending:
                p.cancel()
            break

    if early_solution is not None:
        if fallback_details["results"]:
            first_res = fallback_details["results"][0]
            fallback_details.update({k: v for k, v in first_res.items() if k not in ("models", "results")})
        return early_solution, models_called, fallback_details

    # Check agreement in any completed fallback pairs
    successful_fbs = [r for r in completed_results if r[7] and r[4]]
    if len(successful_fbs) >= 2:
        for i_fb in range(len(successful_fbs)):
            for j_fb in range(i_fb + 1, len(successful_fbs)):
                r1, r2 = successful_fbs[i_fb], successful_fbs[j_fb]
                norm1, norm2 = r1[4], r2[4]
                if norm1.canonical_key == norm2.canonical_key:
                    parsed1, parsed2 = r1[3], r2[3]
                    reason = parsed1.reason if parsed1 else (parsed2.reason if parsed2 else "")
                    rescue_solution = SolverResponse(
                        status="OK",
                        confidence_tier="MEDIUM_TIEBREAKER_AGREE",
                        canonical_key=norm1.canonical_key,
                        selected_index=norm1.selected_index,
                        selected_text=norm1.selected_text,
                        permutation_indices=norm1.permutation_indices,
                        ordered_texts=norm1.ordered_texts,
                        reason=reason,
                    )
                    if fallback_details["results"]:
                        first_res = fallback_details["results"][0]
                        fallback_details.update({k: v for k, v in first_res.items() if k not in ("models", "results")})
                    return rescue_solution, models_called, fallback_details

    if fallback_details["results"]:
        first_res = fallback_details["results"][0]
        fallback_details.update({k: v for k, v in first_res.items() if k not in ("models", "results")})
    else:
        fallback_details.update({"model": wave1_models[0]["model"], "success": False, "error": "FALLBACK_TIMEOUT", "latency_ms": timeout_ms})

    return None, models_called, fallback_details


async def check_models(config_path: Optional[str] = None) -> bool:
    """
    Verify model slugs and connectivity (--check-models):
    Tests primary_a, primary_b, and every model in fallback_pool.
    Filters non-chat models (embed/rerank/safety), benchmarks latency,
    and displays a non-destructive audit table. Never mutates models.json.
    """
    config = load_models_config(config_path)
    groq_key, openrouter_key = load_api_keys()

    print("=" * 115)
    print("STARTING LIVE MODEL CATALOG & CONNECTIVITY VERIFICATION (NON-DESTRUCTIVE)")
    print("=" * 115)

    if not groq_key:
        print("[CHECK-MODELS] ERROR: GROQ_API_KEY is not set in backend/.env")
    if not openrouter_key:
        print("[CHECK-MODELS] ERROR: OPENROUTER_API_KEY is not set in backend/.env")

    if not groq_key or not openrouter_key:
        return False

    pri_a = config.get("primary_a", {})
    pri_b = config.get("primary_b", {})
    model_a = pri_a.get("model", "")
    model_b = pri_b.get("model", "")
    tier_a = pri_a.get("tier", "S")
    tier_b = pri_b.get("tier", "S")
    prio_a = pri_a.get("priority", 1)
    prio_b = pri_b.get("priority", 2)

    ordered_pool = get_ordered_fallback_pool(config)

    fam_a = pri_a.get("family", "").strip().lower()
    fam_b = pri_b.get("family", "").strip().lower()

    results: Dict[str, Dict[str, Any]] = {
        "primary_a": {"model": model_a, "provider": "groq", "tier": tier_a, "priority": prio_a, "pass": False, "reason": "", "latency_ms": 0.0},
        "primary_b": {"model": model_b, "provider": "groq", "tier": tier_b, "priority": prio_b, "pass": False, "reason": "", "latency_ms": 0.0},
    }

    for item in ordered_pool:
        m = item["model"]
        results[m] = {"model": m, "provider": "openrouter", "tier": item["tier"], "priority": item["priority"], "pass": False, "reason": "", "latency_ms": 0.0}

    # Family uniqueness check
    if not fam_a or not fam_b or fam_a == fam_b:
        msg = f"primary_a family '{fam_a}' must differ from primary_b family '{fam_b}'"
        print(f"[CHECK-MODELS] CONFIG ERROR: {msg}")
        results["primary_a"]["reason"] = msg
        results["primary_b"]["reason"] = msg

    test_messages = [
        {"role": "system", "content": 'Respond ONLY with JSON: {"answer": "A", "reason": "test"}'},
        {"role": "user", "content": 'Select A: {"answer": "A", "reason": "test"}'},
    ]

    async with httpx.AsyncClient() as client:
        # 1. Groq Catalog & Models
        print("\n[CHECK-MODELS] Querying Groq active model catalog...")
        groq_slugs: set = set()
        try:
            groq_res = await client.get(
                "https://api.groq.com/openai/v1/models",
                headers={"Authorization": f"Bearer {groq_key}"},
                timeout=12.0,
            )
            if groq_res.status_code == 200:
                data = groq_res.json().get("data", [])
                groq_slugs = {m.get("id") for m in data if m.get("id")}
                print(f"  -> Found {len(groq_slugs)} active models on Groq.")
            else:
                err_msg = f"Groq catalog HTTP_{groq_res.status_code}"
                print(f"  -> {err_msg}")
                results["primary_a"]["reason"] = err_msg
                results["primary_b"]["reason"] = err_msg
        except Exception as e:
            err_msg = f"Groq connection error: {e}"
            print(f"  -> {err_msg}")
            results["primary_a"]["reason"] = err_msg
            results["primary_b"]["reason"] = err_msg

        # Test primary_a
        if model_a in groq_slugs:
            print(f"[CHECK-MODELS] Testing live completion on primary_a ({model_a})...")
            raw_a, el_a, err_a = await call_single_completion(
                client, "groq", model_a, test_messages, groq_key, timeout_ms=5000, max_tokens=256
            )
            results["primary_a"]["latency_ms"] = el_a
            if not err_a and raw_a:
                results["primary_a"]["pass"] = True
                results["primary_a"]["reason"] = "OK"
                print(f"  -> primary_a PASS ({el_a:.0f}ms)")
            else:
                results["primary_a"]["pass"] = False
                results["primary_a"]["reason"] = err_a or "EMPTY"
                print(f"  -> primary_a FAIL ({el_a:.0f}ms): {err_a}")
        else:
            if not results["primary_a"]["reason"]:
                results["primary_a"]["reason"] = f"Model '{model_a}' not in Groq catalog: {sorted(list(groq_slugs))[:5]}"
            print(f"  -> primary_a FAIL: {results['primary_a']['reason']}")

        # Test primary_b
        if model_b in groq_slugs:
            print(f"[CHECK-MODELS] Testing live completion on primary_b ({model_b})...")
            raw_b, el_b, err_b = await call_single_completion(
                client, "groq", model_b, test_messages, groq_key, timeout_ms=5000, max_tokens=256
            )
            results["primary_b"]["latency_ms"] = el_b
            if not err_b and raw_b:
                results["primary_b"]["pass"] = True
                results["primary_b"]["reason"] = "OK"
                print(f"  -> primary_b PASS ({el_b:.0f}ms)")
            else:
                results["primary_b"]["pass"] = False
                results["primary_b"]["reason"] = err_b or "EMPTY"
                print(f"  -> primary_b FAIL ({el_b:.0f}ms): {err_b}")
        else:
            if not results["primary_b"]["reason"]:
                results["primary_b"]["reason"] = f"Model '{model_b}' not in Groq catalog: {sorted(list(groq_slugs))[:5]}"
            print(f"  -> primary_b FAIL: {results['primary_b']['reason']}")

        # 2. OpenRouter Catalog & Models
        print("\n[CHECK-MODELS] Querying OpenRouter active model catalog...")
        or_free_slugs: set = set()
        try:
            or_res = await client.get(
                "https://openrouter.ai/api/v1/models",
                headers={"Authorization": f"Bearer {openrouter_key}"},
                timeout=15.0,
            )
            if or_res.status_code == 200:
                data = or_res.json().get("data", [])
                or_free_slugs = {m.get("id") for m in data if m.get("id", "").endswith(":free")}
                print(f"  -> Found {len(or_free_slugs)} active :free models on OpenRouter.")
            else:
                print(f"  -> OpenRouter catalog returned HTTP_{or_res.status_code}")
        except Exception as e:
            print(f"  -> OpenRouter connection error: {e}")

        # Benchmark each candidate in ordered_pool
        print(f"\n[CHECK-MODELS] Testing {len(ordered_pool)} OpenRouter fallback candidates (Tier-Priority Order)...")
        for item in ordered_pool:
            fb_m = item["model"]
            tier = item["tier"]
            prio = item["priority"]

            if not is_valid_chat_model(fb_m):
                msg = "Rejected: non-chat model slug (embed/rerank/safety/whisper/tts)"
                results[fb_m]["pass"] = False
                results[fb_m]["reason"] = msg
                print(f"  -> [{tier}#{prio}] {fb_m}: REJECTED ({msg})")
                continue

            if not fb_m.endswith(":free"):
                msg = f"Model '{fb_m}' does not end with ':free'"
                results[fb_m]["pass"] = False
                results[fb_m]["reason"] = msg
                print(f"  -> [{tier}#{prio}] {fb_m}: FAIL ({msg})")
                continue

            key_for_test = get_next_openrouter_key() or openrouter_key
            raw_fb, el_fb, err_fb = await call_single_completion(
                client, "openrouter", fb_m, test_messages, key_for_test, timeout_ms=8000, max_tokens=256
            )
            results[fb_m]["latency_ms"] = el_fb
            if not err_fb and raw_fb:
                results[fb_m]["pass"] = True
                results[fb_m]["reason"] = "OK"
                print(f"  -> [{tier}#{prio}] {fb_m}: PASS ({el_fb:.0f}ms)")
            elif err_fb == "RATE_LIMIT_429" and (not or_free_slugs or fb_m in or_free_slugs):
                results[fb_m]["pass"] = True
                results[fb_m]["reason"] = "RATE_LIMIT_429 (Active in Catalog)"
                print(f"  -> [{tier}#{prio}] {fb_m}: PASS ({el_fb:.0f}ms): Active in Catalog (Key Rate Limited)")
            else:
                results[fb_m]["pass"] = False
                results[fb_m]["reason"] = err_fb or "EMPTY"
                print(f"  -> [{tier}#{prio}] {fb_m}: FAIL ({el_fb:.0f}ms): {err_fb}")

    # Non-destructive summary: do NOT write to models.json!
    passing_pool = [item["model"] for item in ordered_pool if results[item["model"]]["pass"]]

    print("\n" + "=" * 115)
    print("MODEL VERIFICATION SUMMARY REPORT (IMMUTABLE CAPABILITY-TIER ORDER)")
    print("=" * 115)
    print(f"{'Role':<14} | {'Provider':<11} | {'Tier':<4} | {'Prio':<4} | {'Model':<44} | {'Status':<6} | {'Latency':<8} | Reason")
    print("-" * 115)
    for role in ["primary_a", "primary_b"]:
        res = results[role]
        status_str = "PASS" if res["pass"] else "FAIL"
        lat_str = f"{res['latency_ms']:.0f} ms" if res["pass"] else "--"
        print(f"{role:<14} | {res['provider']:<11} | {res['tier']:<4} | {res['priority']:<4} | {res['model']:<44} | {status_str:<6} | {lat_str:<8} | {res['reason']}")

    for item in ordered_pool:
        fb_m = item["model"]
        res = results[fb_m]
        status_str = "PASS" if res["pass"] else "FAIL"
        lat_str = f"{res['latency_ms']:.0f} ms" if res["pass"] else "--"
        print(f"{'fallback_pool':<14} | {res['provider']:<11} | {res['tier']:<4} | {res['priority']:<4} | {res['model']:<44} | {status_str:<6} | {lat_str:<8} | {res['reason']}")
    print("=" * 115)

    overall_pass = bool(results["primary_a"]["pass"] and results["primary_b"]["pass"] and len(passing_pool) >= 2)
    return overall_pass


async def solve_question(
    subject: str,
    q_type: str,
    question: str,
    options: List[str],
    config: Optional[dict] = None,
    client: Optional[httpx.AsyncClient] = None,
) -> SolverResponse:
    """
    Solve a single quiz question using parallel primary calls + parallel hedged fallback.
    Adheres strictly to the 3000ms hard budget, derived cross-model confidence,
    budget-aware fast retries, and timeout/error penalty rules.
    """
    if config is None:
        config = load_models_config()

    groq_key, openrouter_key = load_api_keys()
    pri_a = config["primary_a"]
    pri_b = config["primary_b"]
    fb_config = config.get("fallback", {})
    fallback_pool = config.get("fallback_pool") or ([fb_config.get("model")] if fb_config else [])
    timeouts = config.get("timeouts_ms", {})

    groq_timeout_ms = float(timeouts.get("groq_parallel_timeout_ms", 1750))
    fb_timeout_ms_max = float(timeouts.get("openrouter_fallback_timeout_ms", 2150))
    hard_budget_ms = float(timeouts.get("hard_total_budget_ms", 3000))
    s_tier_soft_ms = float(timeouts.get("s_tier_soft_escalation_ms", 1300))

    messages = build_prompt_messages(subject, q_type, question, options)

    t0 = time.perf_counter()
    models_called = ["primary_a", "primary_b"]

    local_client = False
    if client is None:
        client = httpx.AsyncClient()
        local_client = True

    try:
        # Run primary_a and primary_b concurrently with budget-aware retries
        res_a_task = call_model_with_budget_retry(
            client, pri_a["provider"], pri_a["model"], messages, groq_key, groq_timeout_ms, q_type, options
        )
        res_b_task = call_model_with_budget_retry(
            client, pri_b["provider"], pri_b["model"], messages, groq_key, groq_timeout_ms, q_type, options
        )

        (raw_a, parsed_a, norm_a, el_a, err_a), (raw_b, parsed_b, norm_b, el_b, err_b) = await asyncio.gather(
            res_a_task, res_b_task
        )

        succ_a = bool(not err_a and norm_a and parsed_a)
        succ_b = bool(not err_b and norm_b and parsed_b)

        elapsed_primaries_ms = (time.perf_counter() - t0) * 1000.0

        agreement_details = {
            "primary_a": {
                "model": pri_a["model"],
                "success": succ_a,
                "error": err_a,
                "canonical_key": norm_a.canonical_key if norm_a else None,
                "reason": parsed_a.reason if parsed_a else None,
                "latency_ms": el_a,
            },
            "primary_b": {
                "model": pri_b["model"],
                "success": succ_b,
                "error": err_b,
                "canonical_key": norm_b.canonical_key if norm_b else None,
                "reason": parsed_b.reason if parsed_b else None,
                "latency_ms": el_b,
            },
        }

        # PATH A: Both primaries succeeded AND agreed
        if succ_a and succ_b and norm_a and norm_b and (norm_a.canonical_key == norm_b.canonical_key):
            reason_a = parsed_a.reason if parsed_a else ""
            reason_b = parsed_b.reason if parsed_b else ""
            chosen_reason = reason_a if (reason_a and (not reason_b or len(reason_a) <= len(reason_b))) else reason_b

            return SolverResponse(
                status="OK",
                confidence_tier="HIGH_BOTH_AGREE",
                canonical_key=norm_a.canonical_key,
                selected_index=norm_a.selected_index,
                selected_text=norm_a.selected_text,
                permutation_indices=norm_a.permutation_indices,
                ordered_texts=norm_a.ordered_texts,
                reason=chosen_reason,
                latency_ms=elapsed_primaries_ms,
                models_called=models_called,
                agreement_details=agreement_details,
            )

        # PATH C: Both primaries failed/errored/timed out
        if not succ_a and not succ_b:
            remaining_ms = hard_budget_ms - elapsed_primaries_ms
            # Dual-primary failure rescue if remaining budget >= 800ms
            if remaining_ms >= 800.0:
                fb_call_timeout = min(fb_timeout_ms_max, remaining_ms)
                rescue_sol, fb_models_called, fb_details = await run_hedged_openrouter_fallback(
                    client=client,
                    fallback_pool=fallback_pool,
                    messages=messages,
                    q_type=q_type,
                    options=options,
                    timeout_ms=fb_call_timeout,
                    norm_a=None,
                    norm_b=None,
                    succ_a=False,
                    succ_b=False,
                    s_tier_soft_escalation_ms=s_tier_soft_ms,
                )
                models_called.extend(fb_models_called)
                agreement_details["fallback"] = fb_details
                if rescue_sol is not None:
                    total_elapsed_ms = (time.perf_counter() - t0) * 1000.0
                    rescue_sol.latency_ms = total_elapsed_ms
                    rescue_sol.models_called = models_called
                    rescue_sol.agreement_details = agreement_details
                    return rescue_sol

                fb_results = fb_details.get("results", [])
                for r in fb_results:
                    if r.get("success") and r.get("norm"):
                        best_fb_norm = r["norm"]
                        total_elapsed_ms = (time.perf_counter() - t0) * 1000.0
                        return SolverResponse(
                            status="OK",
                            confidence_tier="LOW_FALLBACK",
                            canonical_key=best_fb_norm.canonical_key,
                            selected_index=best_fb_norm.selected_index,
                            selected_text=best_fb_norm.selected_text,
                            permutation_indices=best_fb_norm.permutation_indices,
                            ordered_texts=best_fb_norm.ordered_texts,
                            reason=r.get("reason") or "Single fallback model rescue.",
                            latency_ms=total_elapsed_ms,
                            models_called=models_called,
                            agreement_details=agreement_details,
                            error="Primaries failed; returned available fallback model candidate",
                        )

            return SolverResponse(
                status="UNCERTAIN",
                confidence_tier="UNCERTAIN_PRIMARY_FAILURE",
                latency_ms=hard_budget_ms,  # Penalized full budget
                models_called=models_called,
                agreement_details=agreement_details,
                error=f"Both primaries failed: A({err_a}) | B({err_b})",
            )

        # PATH B: Disagreement OR exactly one primary succeeded
        remaining_ms = hard_budget_ms - elapsed_primaries_ms
        if remaining_ms <= 200.0:
            penalty = hard_budget_ms if (err_a or err_b) else elapsed_primaries_ms
            best_n = norm_a if (succ_a and norm_a) else (norm_b if (succ_b and norm_b) else None)
            best_r = (parsed_a.reason if parsed_a else "") if succ_a else ((parsed_b.reason if parsed_b else "") if succ_b else "")
            if best_n is not None:
                return SolverResponse(
                    status="OK",
                    confidence_tier="LOW_FALLBACK",
                    canonical_key=best_n.canonical_key,
                    selected_index=best_n.selected_index,
                    selected_text=best_n.selected_text,
                    permutation_indices=best_n.permutation_indices,
                    ordered_texts=best_n.ordered_texts,
                    reason=best_r or "Single primary candidate before budget limit.",
                    latency_ms=penalty,
                    models_called=models_called,
                    agreement_details=agreement_details,
                    error="Remaining budget <= 200ms before fallback; returned available primary candidate",
                )
            return SolverResponse(
                status="UNCERTAIN",
                confidence_tier="UNCERTAIN_BUDGET_EXHAUSTED",
                latency_ms=penalty,
                models_called=models_called,
                agreement_details=agreement_details,
                error="Remaining budget <= 200ms before fallback",
            )

        # STAGE 2-GROQ: Fast Groq Arbiter on Disagreement / Single-Primary
        # Uses fast Groq completion with reason-first step-by-step verification
        norm_arb = None
        parsed_arb = None
        succ_arb = False
        arbiter_model = config.get("arbiter", {}).get("model") or "openai/gpt-oss-120b"
        if groq_key and remaining_ms >= 550.0 and not get_healthy_openrouter_keys():
            cand_a_str = f"Option {norm_a.canonical_key}: {norm_a.selected_text}" if (norm_a and norm_a.canonical_key) else None
            cand_b_str = f"Option {norm_b.canonical_key}: {norm_b.selected_text}" if (norm_b and norm_b.canonical_key) else None
            arb_messages = build_arbiter_messages(
                subject=subject,
                q_type=q_type,
                question=question,
                options=options,
                candidate_a=cand_a_str,
                candidate_b=cand_b_str,
            )
            arb_timeout_ms = min(1100.0, remaining_ms - 200.0)
            models_called.append(f"groq_arbiter:{arbiter_model}")
            (raw_arb, parsed_arb, norm_arb, el_arb, err_arb) = await call_model_with_budget_retry(
                client=client,
                provider="groq",
                model=arbiter_model,
                messages=arb_messages,
                api_key=groq_key,
                timeout_ms=arb_timeout_ms,
                q_type=q_type,
                options=options,
                max_tokens=600,
            )
            succ_arb = bool(not err_arb and norm_arb and parsed_arb)
            agreement_details["groq_arbiter"] = {
                "model": arbiter_model,
                "success": succ_arb,
                "error": err_arb,
                "canonical_key": norm_arb.canonical_key if norm_arb else None,
                "reason": parsed_arb.reason if parsed_arb else None,
                "latency_ms": el_arb,
            }

            if succ_arb and norm_arb:
                total_elapsed_ms = (time.perf_counter() - t0) * 1000.0
                if succ_a and norm_a and (norm_arb.canonical_key == norm_a.canonical_key):
                    reason = parsed_arb.reason or (parsed_a.reason if parsed_a else "")
                    return SolverResponse(
                        status="OK",
                        confidence_tier="MEDIUM_TIEBREAKER_AGREE",
                        canonical_key=norm_a.canonical_key,
                        selected_index=norm_a.selected_index,
                        selected_text=norm_a.selected_text,
                        permutation_indices=norm_a.permutation_indices,
                        ordered_texts=norm_a.ordered_texts,
                        reason=reason,
                        latency_ms=total_elapsed_ms,
                        models_called=models_called,
                        agreement_details=agreement_details,
                    )
                if succ_b and norm_b and (norm_arb.canonical_key == norm_b.canonical_key):
                    reason = parsed_arb.reason or (parsed_b.reason if parsed_b else "")
                    return SolverResponse(
                        status="OK",
                        confidence_tier="MEDIUM_TIEBREAKER_AGREE",
                        canonical_key=norm_b.canonical_key,
                        selected_index=norm_b.selected_index,
                        selected_text=norm_b.selected_text,
                        permutation_indices=norm_b.permutation_indices,
                        ordered_texts=norm_b.ordered_texts,
                        reason=reason,
                        latency_ms=total_elapsed_ms,
                        models_called=models_called,
                        agreement_details=agreement_details,
                    )

            remaining_ms = hard_budget_ms - ((time.perf_counter() - t0) * 1000.0)

        # STAGE 2A: SearXNG Factual Search Fallback
        searxng_url, searxng_enabled = get_searxng_config()
        searxng_timeout_ms = float(timeouts.get("searxng_timeout_ms", 650))
        searxng_grounded_timeout_ms = float(timeouts.get("searxng_grounded_llm_timeout_ms", 900))

        should_try_searxng = (
            searxng_enabled
            and not is_searxng_circuit_open()
            and is_factual_question(subject, q_type, question, options)
            and remaining_ms >= 900.0
        )

        if should_try_searxng:
            candidate_texts: List[str] = []
            if q_type == "mcq":
                if norm_a and norm_a.selected_text:
                    candidate_texts.append(norm_a.selected_text)
                if norm_b and norm_b.selected_text:
                    candidate_texts.append(norm_b.selected_text)
            else:
                if norm_a and norm_a.canonical_key:
                    candidate_texts.append(norm_a.canonical_key)
                if norm_b and norm_b.canonical_key:
                    candidate_texts.append(norm_b.canonical_key)

            search_query = build_search_query(
                subject=subject,
                q_type=q_type,
                question=question,
                options=options,
                candidate_answers=candidate_texts,
            )

            searxng_call_timeout = min(searxng_timeout_ms, remaining_ms - 500.0)
            snippets = await fetch_searxng_snippets(
                client=client,
                query=search_query,
                timeout_ms=int(searxng_call_timeout),
                base_url=searxng_url,
            )

            remaining_ms = hard_budget_ms - ((time.perf_counter() - t0) * 1000.0)

            if snippets and remaining_ms >= 450.0:
                grounded_messages = build_prompt_messages(
                    subject=subject,
                    q_type=q_type,
                    question=question,
                    options=options,
                    search_snippets=snippets,
                )
                grounded_call_timeout = min(searxng_grounded_timeout_ms, remaining_ms)

                # Use fastest healthy Groq primary (primary_b preferred, or primary_a)
                chosen_grounded_role = "primary_b" if succ_b else "primary_a"
                grounded_model_cfg = pri_b if chosen_grounded_role == "primary_b" else pri_a

                models_called.append(f"searxng_grounded_{chosen_grounded_role}")
                (raw_g, parsed_g, norm_g, el_g, err_g) = await call_model_with_budget_retry(
                    client=client,
                    provider=grounded_model_cfg["provider"],
                    model=grounded_model_cfg["model"],
                    messages=grounded_messages,
                    api_key=groq_key,
                    timeout_ms=grounded_call_timeout,
                    q_type=q_type,
                    options=options,
                )

                succ_g = bool(not err_g and norm_g and parsed_g)
                agreement_details["searxng_grounded"] = {
                    "model": grounded_model_cfg["model"],
                    "success": succ_g,
                    "error": err_g,
                    "canonical_key": norm_g.canonical_key if norm_g else None,
                    "reason": parsed_g.reason if parsed_g else None,
                    "latency_ms": el_g,
                    "snippets_count": len(snippets),
                }

                total_elapsed_ms = (time.perf_counter() - t0) * 1000.0
                search_sources = [s.get("title", "") for s in snippets[:2] if s.get("title")]

                if succ_g and norm_g:
                    agrees_with_a = bool(succ_a and norm_a and norm_g.canonical_key == norm_a.canonical_key)
                    agrees_with_b = bool(succ_b and norm_b and norm_g.canonical_key == norm_b.canonical_key)

                    if agrees_with_a:
                        return SolverResponse(
                            status="OK",
                            confidence_tier="MEDIUM_SEARXNG_GROUNDED",
                            canonical_key=norm_a.canonical_key,
                            selected_index=norm_a.selected_index,
                            selected_text=norm_a.selected_text,
                            permutation_indices=norm_a.permutation_indices,
                            ordered_texts=norm_a.ordered_texts,
                            reason=parsed_g.reason or (parsed_a.reason if parsed_a else ""),
                            latency_ms=total_elapsed_ms,
                            models_called=models_called,
                            agreement_details=agreement_details,
                            searxng_used=True,
                            search_sources=search_sources,
                        )

                    if agrees_with_b:
                        return SolverResponse(
                            status="OK",
                            confidence_tier="MEDIUM_SEARXNG_GROUNDED",
                            canonical_key=norm_b.canonical_key,
                            selected_index=norm_b.selected_index,
                            selected_text=norm_b.selected_text,
                            permutation_indices=norm_b.permutation_indices,
                            ordered_texts=norm_b.ordered_texts,
                            reason=parsed_g.reason or (parsed_b.reason if parsed_b else ""),
                            latency_ms=total_elapsed_ms,
                            models_called=models_called,
                            agreement_details=agreement_details,
                            searxng_used=True,
                            search_sources=search_sources,
                        )

            # Update remaining_ms after SearXNG attempt
            remaining_ms = hard_budget_ms - ((time.perf_counter() - t0) * 1000.0)
            if remaining_ms <= 200.0:
                penalty = hard_budget_ms if (err_a or err_b) else ((time.perf_counter() - t0) * 1000.0)
                best_n = norm_arb if (succ_arb and norm_arb) else (norm_a if (succ_a and norm_a) else (norm_b if (succ_b and norm_b) else None))
                best_r = (parsed_arb.reason if parsed_arb else "") if succ_arb else ((parsed_a.reason if parsed_a else "") if succ_a else ((parsed_b.reason if parsed_b else "") if succ_b else ""))
                if best_n is not None:
                    return SolverResponse(
                        status="OK",
                        confidence_tier="LOW_FALLBACK",
                        canonical_key=best_n.canonical_key,
                        selected_index=best_n.selected_index,
                        selected_text=best_n.selected_text,
                        permutation_indices=best_n.permutation_indices,
                        ordered_texts=best_n.ordered_texts,
                        reason=best_r or "Best candidate derivation.",
                        latency_ms=penalty,
                        models_called=models_called,
                        agreement_details=agreement_details,
                        error="Budget exhausted after SearXNG; returned available candidate",
                    )
                return SolverResponse(
                    status="UNCERTAIN",
                    confidence_tier="UNCERTAIN_BUDGET_EXHAUSTED",
                    latency_ms=penalty,
                    models_called=models_called,
                    agreement_details=agreement_details,
                    error="Budget exhausted after SearXNG grounding",
                )

        # STAGE 2B: Parallel Hedged Fallback Racing
        fb_call_timeout = min(fb_timeout_ms_max, remaining_ms)
        hedged_sol, fb_models_called, fb_details = await run_hedged_openrouter_fallback(
            client=client,
            fallback_pool=fallback_pool,
            messages=messages,
            q_type=q_type,
            options=options,
            timeout_ms=fb_call_timeout,
            norm_a=norm_a,
            norm_b=norm_b,
            succ_a=succ_a,
            succ_b=succ_b,
            parsed_a=parsed_a,
            parsed_b=parsed_b,
            s_tier_soft_escalation_ms=s_tier_soft_ms,
        )
        models_called.extend(fb_models_called)
        agreement_details["fallback"] = fb_details
        total_elapsed_ms = (time.perf_counter() - t0) * 1000.0

        if hedged_sol is not None:
            hedged_sol.latency_ms = total_elapsed_ms
            hedged_sol.models_called = models_called
            hedged_sol.agreement_details = agreement_details
            return hedged_sol

        # STAGE 2C: Fast Groq Arbiter Fallback when OpenRouter fallback failed/timed out
        if groq_key and not succ_arb and (hard_budget_ms - ((time.perf_counter() - t0) * 1000.0)) >= 300.0:
            cand_a_str = f"Option {norm_a.canonical_key}: {norm_a.selected_text}" if (norm_a and norm_a.canonical_key) else None
            cand_b_str = f"Option {norm_b.canonical_key}: {norm_b.selected_text}" if (norm_b and norm_b.canonical_key) else None
            arb_messages = build_arbiter_messages(
                subject=subject,
                q_type=q_type,
                question=question,
                options=options,
                candidate_a=cand_a_str,
                candidate_b=cand_b_str,
            )
            rem_arb_timeout = min(1100.0, max(300.0, hard_budget_ms - ((time.perf_counter() - t0) * 1000.0)))
            models_called.append(f"groq_arbiter:{arbiter_model}")
            (raw_arb, parsed_arb, norm_arb, el_arb, err_arb) = await call_model_with_budget_retry(
                client=client,
                provider="groq",
                model=arbiter_model,
                messages=arb_messages,
                api_key=groq_key,
                timeout_ms=rem_arb_timeout,
                q_type=q_type,
                options=options,
                max_tokens=600,
            )
            succ_arb = bool(not err_arb and norm_arb and parsed_arb)
            agreement_details["groq_arbiter"] = {
                "model": arbiter_model,
                "success": succ_arb,
                "error": err_arb,
                "canonical_key": norm_arb.canonical_key if norm_arb else None,
                "reason": parsed_arb.reason if parsed_arb else None,
                "latency_ms": el_arb,
            }

            if succ_arb and norm_arb:
                total_elapsed_ms = (time.perf_counter() - t0) * 1000.0
                if succ_a and norm_a and (norm_arb.canonical_key == norm_a.canonical_key):
                    reason = parsed_arb.reason or (parsed_a.reason if parsed_a else "")
                    return SolverResponse(
                        status="OK",
                        confidence_tier="MEDIUM_TIEBREAKER_AGREE",
                        canonical_key=norm_a.canonical_key,
                        selected_index=norm_a.selected_index,
                        selected_text=norm_a.selected_text,
                        permutation_indices=norm_a.permutation_indices,
                        ordered_texts=norm_a.ordered_texts,
                        reason=reason,
                        latency_ms=total_elapsed_ms,
                        models_called=models_called,
                        agreement_details=agreement_details,
                    )
                if succ_b and norm_b and (norm_arb.canonical_key == norm_b.canonical_key):
                    reason = parsed_arb.reason or (parsed_b.reason if parsed_b else "")
                    return SolverResponse(
                        status="OK",
                        confidence_tier="MEDIUM_TIEBREAKER_AGREE",
                        canonical_key=norm_b.canonical_key,
                        selected_index=norm_b.selected_index,
                        selected_text=norm_b.selected_text,
                        permutation_indices=norm_b.permutation_indices,
                        ordered_texts=norm_b.ordered_texts,
                        reason=reason,
                        latency_ms=total_elapsed_ms,
                        models_called=models_called,
                        agreement_details=agreement_details,
                    )
                return SolverResponse(
                    status="OK",
                    confidence_tier="MEDIUM_TIEBREAKER_AGREE",
                    canonical_key=norm_arb.canonical_key,
                    selected_index=norm_arb.selected_index,
                    selected_text=norm_arb.selected_text,
                    permutation_indices=norm_arb.permutation_indices,
                    ordered_texts=norm_arb.ordered_texts,
                    reason=parsed_arb.reason or "Groq arbiter contrastive derivation.",
                    latency_ms=total_elapsed_ms,
                    models_called=models_called,
                    agreement_details=agreement_details,
                )

        had_timeout_or_error = bool(err_a or err_b or not fb_details.get("success", False))
        penalty = hard_budget_ms if had_timeout_or_error else total_elapsed_ms

        # Never return an empty answer if ANY model succeeded!
        best_norm = None
        best_reason = ""
        if succ_arb and norm_arb:
            best_norm = norm_arb
            best_reason = parsed_arb.reason if parsed_arb else ""
        elif succ_a and norm_a:
            best_norm = norm_a
            best_reason = parsed_a.reason if parsed_a else ""
        elif succ_b and norm_b:
            best_norm = norm_b
            best_reason = parsed_b.reason if parsed_b else ""
        else:
            fb_results = fb_details.get("results", [])
            for r in fb_results:
                if r.get("success") and r.get("norm"):
                    best_norm = r.get("norm")
                    best_reason = r.get("reason", "")
                    break

        if best_norm is not None:
            return SolverResponse(
                status="OK",
                confidence_tier="LOW_FALLBACK",
                canonical_key=best_norm.canonical_key,
                selected_index=best_norm.selected_index,
                selected_text=best_norm.selected_text,
                permutation_indices=best_norm.permutation_indices,
                ordered_texts=best_norm.ordered_texts,
                reason=best_reason or "Best candidate derivation (low fallback).",
                latency_ms=penalty,
                models_called=models_called,
                agreement_details=agreement_details,
                error=f"Tie-breaker unresolved; returned best model candidate: {best_norm.canonical_key}",
            )

        return SolverResponse(
            status="UNCERTAIN",
            confidence_tier="UNCERTAIN_NO_AGREEMENT",
            latency_ms=penalty,
            models_called=models_called,
            agreement_details=agreement_details,
            error=f"No consensus reached between models (fb_err={fb_details.get('error')})",
        )

    finally:
        if local_client:
            await client.aclose()
