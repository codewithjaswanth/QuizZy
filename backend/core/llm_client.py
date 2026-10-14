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
from backend.core.prompts import build_prompt_messages
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


def load_api_keys() -> Tuple[str, str]:
    """Load GROQ_API_KEY and OPENROUTER_API_KEY from backend/.env or environment."""
    env_path = find_env_file()
    if env_path.is_file():
        load_dotenv(dotenv_path=env_path)
    else:
        load_dotenv()

    groq_key = os.getenv("GROQ_API_KEY", "").strip()
    openrouter_key = os.getenv("OPENROUTER_API_KEY", "").strip()
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
) -> Tuple[Optional[str], float, Optional[str]]:
    """
    Call a single LLM provider chat completions endpoint with timeout.
    Uses max_tokens >= 512 and falls back to reasoning fields if content is empty.
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
            "max_tokens": 512,
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
            "max_tokens": 512,
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
                return None, elapsed_ms, "EMPTY_CHOICES_CONTENT"
            return None, elapsed_ms, "EMPTY_CHOICES"
        elif response.status_code == 429:
            return None, elapsed_ms, "RATE_LIMIT_429"
        else:
            return None, elapsed_ms, f"HTTP_{response.status_code}: {response.text[:150]}"

    except httpx.TimeoutException:
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return None, elapsed_ms, "TIMEOUT"
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
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
) -> Tuple[Optional[str], Optional[ParsedLLMResponse], Optional[NormalizedAnswer], float, Optional[str]]:
    """
    Call model with budget-aware single fast retry on transient 5xx, network error,
    or ParseError (never on 429 or timeout) ONLY if elapsed time in current stage < 700 ms (100ms backoff).
    Returns: (raw_text, parsed_response, normalized_answer, elapsed_ms, error_string)
    """
    t_start = time.perf_counter()
    raw, el, err = await call_single_completion(client, provider, model, messages, api_key, timeout_ms)

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
                    raw, el2, err = await call_single_completion(client, provider, model, messages, api_key, rem_timeout)

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
                    raw2, el2, err2 = await call_single_completion(client, provider, model, messages, api_key, rem_timeout)
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


async def check_models(config_path: Optional[str] = None) -> bool:
    """
    Verify model slugs and connectivity (--check-models):
    Checks ALL THREE models (primary_a, primary_b, AND fallback) in a single execution
    without returning early on the first error.
    Reports PASS/FAIL, reason, and latency ms for each model.
    """
    config = load_models_config(config_path)
    groq_key, openrouter_key = load_api_keys()

    print("=" * 70)
    print("STARTING LIVE MODEL CATALOG & CONNECTIVITY VERIFICATION")
    print("=" * 70)

    if not groq_key:
        print("[CHECK-MODELS] ERROR: GROQ_API_KEY is not set in backend/.env")
    if not openrouter_key:
        print("[CHECK-MODELS] ERROR: OPENROUTER_API_KEY is not set in backend/.env")

    if not groq_key or not openrouter_key:
        return False

    pri_a = config.get("primary_a", {})
    pri_b = config.get("primary_b", {})
    fb = config.get("fallback", {})

    model_a = pri_a.get("model", "")
    model_b = pri_b.get("model", "")
    model_fb = fb.get("model", "")

    fam_a = pri_a.get("family", "").strip().lower()
    fam_b = pri_b.get("family", "").strip().lower()

    results: Dict[str, Dict[str, Any]] = {
        "primary_a": {"model": model_a, "provider": "groq", "pass": False, "reason": "", "latency_ms": 0.0},
        "primary_b": {"model": model_b, "provider": "groq", "pass": False, "reason": "", "latency_ms": 0.0},
        "fallback": {"model": model_fb, "provider": "openrouter", "pass": False, "reason": "", "latency_ms": 0.0},
    }

    # Family uniqueness check
    if not fam_a or not fam_b or fam_a == fam_b:
        msg = f"primary_a family '{fam_a}' must differ from primary_b family '{fam_b}'"
        print(f"[CHECK-MODELS] CONFIG ERROR: {msg}")
        results["primary_a"]["reason"] = msg
        results["primary_b"]["reason"] = msg

    # Fallback ends with :free check
    if not model_fb.endswith(":free"):
        msg = f"fallback model '{model_fb}' must end with ':free'"
        print(f"[CHECK-MODELS] CONFIG ERROR: {msg}")
        results["fallback"]["reason"] = msg

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
                client, "groq", model_a, test_messages, groq_key, timeout_ms=5000
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
                client, "groq", model_b, test_messages, groq_key, timeout_ms=5000
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
                err_msg = f"OpenRouter catalog HTTP_{or_res.status_code}"
                print(f"  -> {err_msg}")
                results["fallback"]["reason"] = err_msg
        except Exception as e:
            err_msg = f"OpenRouter connection error: {e}"
            print(f"  -> {err_msg}")
            results["fallback"]["reason"] = err_msg

        # Test fallback
        if model_fb in or_free_slugs:
            print(f"[CHECK-MODELS] Testing live completion on fallback ({model_fb})...")
            raw_fb, el_fb, err_fb = await call_single_completion(
                client, "openrouter", model_fb, test_messages, openrouter_key, timeout_ms=8000
            )
            results["fallback"]["latency_ms"] = el_fb
            if not err_fb and raw_fb:
                results["fallback"]["pass"] = True
                results["fallback"]["reason"] = "OK"
                print(f"  -> fallback PASS ({el_fb:.0f}ms)")
            else:
                results["fallback"]["pass"] = False
                results["fallback"]["reason"] = err_fb or "EMPTY"
                print(f"  -> fallback FAIL ({el_fb:.0f}ms): {err_fb}")
        else:
            if not results["fallback"]["reason"]:
                results["fallback"]["reason"] = f"Model '{model_fb}' not found in OpenRouter :free list: {sorted(list(or_free_slugs))[:5]}"
            print(f"  -> fallback FAIL: {results['fallback']['reason']}")

    # Summary Report Table
    print("\n" + "=" * 70)
    print("MODEL VERIFICATION SUMMARY REPORT")
    print("=" * 70)
    print(f"{'Role':<12} | {'Provider':<11} | {'Model':<35} | {'Status':<6} | {'Latency':<8} | Reason")
    print("-" * 95)
    all_passed = True
    for role in ["primary_a", "primary_b", "fallback"]:
        res = results[role]
        status_str = "PASS" if res["pass"] else "FAIL"
        lat_str = f"{res['latency_ms']:.0f} ms" if res["pass"] else "--"
        print(f"{role:<12} | {res['provider']:<11} | {res['model']:<35} | {status_str:<6} | {lat_str:<8} | {res['reason']}")
        if not res["pass"]:
            all_passed = False
    print("=" * 70)

    return all_passed


async def solve_question(
    subject: str,
    q_type: str,
    question: str,
    options: List[str],
    config: Optional[dict] = None,
    client: Optional[httpx.AsyncClient] = None,
) -> SolverResponse:
    """
    Solve a single quiz question using parallel primary calls + conditional fallback.
    Adheres strictly to the 3000ms hard budget, derived cross-model confidence,
    budget-aware fast retries, and timeout/error penalty rules.
    """
    if config is None:
        config = load_models_config()

    groq_key, openrouter_key = load_api_keys()
    pri_a = config["primary_a"]
    pri_b = config["primary_b"]
    fb = config["fallback"]
    timeouts = config.get("timeouts_ms", {})

    groq_timeout_ms = float(timeouts.get("groq_parallel_timeout_ms", 1800))
    fb_timeout_ms_max = float(timeouts.get("openrouter_fallback_timeout_ms", 2200))
    hard_budget_ms = float(timeouts.get("hard_total_budget_ms", 3000))

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
            return SolverResponse(
                status="UNCERTAIN",
                confidence_tier="UNCERTAIN_BUDGET_EXHAUSTED",
                latency_ms=penalty,
                models_called=models_called,
                agreement_details=agreement_details,
                error="Remaining budget <= 200ms before fallback",
            )

        # STAGE 2A: SearXNG Factual Search Fallback
        searxng_url, searxng_enabled = get_searxng_config()
        searxng_timeout_ms = float(timeouts.get("searxng_timeout_ms", 700))
        searxng_grounded_timeout_ms = float(timeouts.get("searxng_grounded_llm_timeout_ms", 950))

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
                return SolverResponse(
                    status="UNCERTAIN",
                    confidence_tier="UNCERTAIN_BUDGET_EXHAUSTED",
                    latency_ms=penalty,
                    models_called=models_called,
                    agreement_details=agreement_details,
                    error="Budget exhausted after SearXNG grounding",
                )

        # Trigger Fallback with budget-aware retry
        models_called.append("fallback")
        fb_call_timeout = min(fb_timeout_ms_max, remaining_ms)
        raw_fb, parsed_fb, norm_fb, el_fb, err_fb = await call_model_with_budget_retry(
            client, fb["provider"], fb["model"], messages, openrouter_key, fb_call_timeout, q_type, options
        )

        succ_fb = bool(not err_fb and norm_fb and parsed_fb)
        total_elapsed_ms = (time.perf_counter() - t0) * 1000.0

        agreement_details["fallback"] = {
            "model": fb["model"],
            "success": succ_fb,
            "error": err_fb,
            "canonical_key": norm_fb.canonical_key if norm_fb else None,
            "reason": parsed_fb.reason if parsed_fb else None,
            "latency_ms": el_fb,
        }

        # Check fallback agreement
        if succ_fb and norm_fb:
            if succ_a and norm_a and norm_fb.canonical_key == norm_a.canonical_key:
                tier = "MEDIUM_TIEBREAKER_AGREE" if succ_b else "LOW_FALLBACK_RESCUE"
                return SolverResponse(
                    status="OK",
                    confidence_tier=tier,
                    canonical_key=norm_a.canonical_key,
                    selected_index=norm_a.selected_index,
                    selected_text=norm_a.selected_text,
                    permutation_indices=norm_a.permutation_indices,
                    ordered_texts=norm_a.ordered_texts,
                    reason=parsed_fb.reason or (parsed_a.reason if parsed_a else ""),
                    latency_ms=total_elapsed_ms,
                    models_called=models_called,
                    agreement_details=agreement_details,
                )

            if succ_b and norm_b and norm_fb.canonical_key == norm_b.canonical_key:
                tier = "MEDIUM_TIEBREAKER_AGREE" if succ_a else "LOW_FALLBACK_RESCUE"
                return SolverResponse(
                    status="OK",
                    confidence_tier=tier,
                    canonical_key=norm_b.canonical_key,
                    selected_index=norm_b.selected_index,
                    selected_text=norm_b.selected_text,
                    permutation_indices=norm_b.permutation_indices,
                    ordered_texts=norm_b.ordered_texts,
                    reason=parsed_fb.reason or (parsed_b.reason if parsed_b else ""),
                    latency_ms=total_elapsed_ms,
                    models_called=models_called,
                    agreement_details=agreement_details,
                )

        had_timeout_or_error = bool(err_a or err_b or err_fb or not succ_fb)
        penalty = hard_budget_ms if had_timeout_or_error else total_elapsed_ms

        return SolverResponse(
            status="UNCERTAIN",
            confidence_tier="UNCERTAIN_NO_AGREEMENT",
            latency_ms=penalty,
            models_called=models_called,
            agreement_details=agreement_details,
            error=f"No consensus reached between models (fb_err={err_fb})",
        )

    finally:
        if local_client:
            await client.aclose()
