"""QuizZy local FastAPI backend application."""

from __future__ import annotations

import csv
import hashlib
import json
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

import httpx
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.cache import (
    cache_solution,
    get_cache_stats,
    get_cached_solution,
    get_wrong_answers,
    init_db,
    record_wrong_answer,
)
from backend.core.llm_client import (
    get_active_fallback_pool,
    load_models_config,
    load_openrouter_api_keys,
    solve_question,
)
from backend.core.normalizer import normalize_text_answer
from backend.core.searxng_client import get_searxng_config, is_searxng_circuit_open
from backend.schemas import (
    FeedbackRequest,
    FeedbackResponse,
    HealthResponse,
    SolveRequest,
    SolveResponse,
    StatsResponse,
)


def save_or_update_question_csv(
    subject: str,
    q_type: str,
    question: str,
    options: List[str],
    correct_answer: Any,
    csv_path: Optional[str] = None,
) -> Tuple[bool, str]:
    """
    Append or update in-place a question row in questions.csv with deduplication.
    Uses canonical format for expected_answer (letter for MCQ, permutation for Order, text for Text).
    """
    path = Path(csv_path) if csv_path else Path(__file__).resolve().parent.parent / "questions.csv"
    norm_type = q_type.strip().lower()

    # Format expected_answer
    if norm_type == "mcq":
        raw_str = str(correct_answer).strip()
        if len(raw_str) == 1 and raw_str.upper() in "ABCDEF":
            expected = raw_str.upper()
        else:
            # Find in options
            cand_norm = normalize_text_answer(raw_str)
            found_idx = None
            for idx, opt in enumerate(options):
                if normalize_text_answer(opt) == cand_norm:
                    found_idx = idx
                    break
            expected = chr(65 + found_idx) if found_idx is not None else raw_str.upper()

    elif norm_type == "order":
        if isinstance(correct_answer, list):
            # Check if list of letters or list of option texts
            if all(isinstance(x, str) and len(x.strip()) == 1 and x.strip().upper() in "ABCDEF" for x in correct_answer):
                expected = ",".join([x.strip().upper() for x in correct_answer])
            else:
                # List of option texts -> map to letters
                letters = []
                for item in correct_answer:
                    item_norm = normalize_text_answer(str(item))
                    for idx, opt in enumerate(options):
                        if normalize_text_answer(opt) == item_norm:
                            letters.append(chr(65 + idx))
                            break
                expected = ",".join(letters) if len(letters) == len(options) else str(correct_answer)
        else:
            expected = str(correct_answer).strip()

    elif norm_type == "text":
        expected = str(correct_answer).strip()

    else:
        expected = str(correct_answer).strip()

    options_json = json.dumps(options or [])
    norm_q = normalize_text_answer(question)
    sorted_norm_opts = sorted([normalize_text_answer(o) for o in options])

    existing_rows: List[Dict[str, str]] = []
    matched_id: Optional[str] = None

    if path.is_file():
        with open(path, mode="r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                r_q = normalize_text_answer(row.get("question", ""))
                try:
                    r_opts = json.loads(row.get("options_json", "[]"))
                except Exception:
                    r_opts = []
                r_sorted_opts = sorted([normalize_text_answer(o) for o in r_opts])

                if r_q == norm_q and (norm_type == "text" or r_sorted_opts == sorted_norm_opts):
                    # Duplicate found -> update row in place
                    matched_id = row.get("id")
                    row["subject"] = subject
                    row["q_type"] = norm_type
                    row["question"] = question
                    row["options_json"] = options_json
                    row["expected_answer"] = expected
                existing_rows.append(row)

    if matched_id:
        final_id = matched_id
    else:
        short_hash = hashlib.sha256(f"{subject}:{norm_type}:{question}".encode("utf-8")).hexdigest()[:8].upper()
        final_id = f"REAL_{short_hash}"
        existing_rows.append({
            "id": final_id,
            "subject": subject,
            "q_type": norm_type,
            "question": question,
            "options_json": options_json,
            "expected_answer": expected,
        })

    fieldnames = ["id", "subject", "q_type", "question", "options_json", "expected_answer"]
    with open(path, mode="w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in existing_rows:
            writer.writerow({k: r.get(k, "") for k in fieldnames})

    return True, final_id


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Manage lifecycle of shared HTTP client, models configuration, and SQLite cache."""
    # Startup
    init_db()
    app.state.models_config = load_models_config()
    app.state.http_client = httpx.AsyncClient()
    yield
    # Shutdown
    await app.state.http_client.aclose()


app = FastAPI(
    title="QuizZy Backend API",
    version="1.0.0",
    description="Fast, local, order-invariant quiz solver engine backend.",
    lifespan=lifespan,
)

# CORS: Allow localhost (any port) and Chrome extension origins
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|http://localhost(:\d+)?|http://127\.0\.0\.1(:\d+)?)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """System health check and loaded models summary."""
    stats = get_cache_stats()
    models_summary = getattr(app.state, "models_config", {})
    _, searxng_enabled = get_searxng_config()
    openrouter_keys = load_openrouter_api_keys()
    active_pool = get_active_fallback_pool(models_summary)
    return HealthResponse(
        status="ok",
        models=models_summary,
        cache_entries=stats.get("cache_entries", 0),
        searxng_enabled=searxng_enabled,
        searxng_circuit_open=is_searxng_circuit_open(),
        openrouter_keys_loaded=len(openrouter_keys),
        active_fallback_pool=active_pool,
    )


@app.get("/stats", response_model=StatsResponse)
async def cache_statistics() -> StatsResponse:
    """Retrieve cache hit/miss operational metrics and wrong answer counts."""
    stats = get_cache_stats()
    return StatsResponse(
        status="ok",
        cache_entries=stats["cache_entries"],
        total_hits=stats["total_hits"],
        total_misses=stats["total_misses"],
        total_requests=stats["total_requests"],
        hit_rate_pct=stats["hit_rate_pct"],
        wrong_answers_count=stats.get("wrong_answers_count", 0),
        user_overrides_count=stats.get("user_overrides_count", 0),
    )


@app.post("/solve", response_model=SolveResponse)
async def solve_endpoint(req: SolveRequest) -> SolveResponse:
    """
    Solve a quiz question across MCQ, unlabelled order blocks, and free text.
    Checks the order-invariant SQLite cache first (unless bypass_cache=True).
    On cache miss, runs parallel primary models + fallback solver, enforcing
    Zero-Poison caching rules and derived cross-model confidence.
    """
    t0 = time.perf_counter()

    # 1. Cache Lookup (unless bypassed)
    if not req.bypass_cache:
        cached = get_cached_solution(
            subject=req.subject,
            q_type=req.q_type,
            question=req.question,
            options=req.options,
        )
        if cached:
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            return SolveResponse(
                status="ok",
                q_type=req.q_type,
                answer=cached.get("answer", ""),
                selected_index=cached.get("selected_index"),
                selected_text=cached.get("selected_text"),
                permutation_indices=cached.get("permutation_indices"),
                ordered_texts=cached.get("ordered_texts"),
                reason=cached.get("reason", ""),
                confidence_tier=cached.get("confidence_tier", ""),
                confidence_label=cached.get("confidence_label", "high"),
                confidence_score=cached.get("confidence_score", 1.0),
                auto_eligible=cached.get("auto_eligible", True),
                cache_hit=True,
                latency_ms=round(elapsed_ms, 2),
                searxng_used=cached.get("searxng_used", False),
                search_sources=cached.get("search_sources", []),
            )

    # 2. Live Solver Execution
    client = getattr(app.state, "http_client", None)
    config = getattr(app.state, "models_config", None)

    solver_res = await solve_question(
        subject=req.subject,
        q_type=req.q_type,
        question=req.question,
        options=req.options,
        config=config,
        client=client,
    )

    tier = solver_res.confidence_tier
    is_ok = (solver_res.status.upper() == "OK")

    # Map Confidence Tiers to API contracts
    if tier in ("HIGH_BOTH_AGREE", "USER_VERIFIED_OVERRIDE"):
        confidence_label = "high"
        confidence_score = 1.0
        auto_eligible = is_ok
    elif tier == "MEDIUM_SEARXNG_GROUNDED":
        confidence_label = "medium"
        confidence_score = 0.75
        auto_eligible = is_ok
    elif tier == "MEDIUM_TIEBREAKER_AGREE":
        confidence_label = "medium"
        confidence_score = 0.67
        auto_eligible = is_ok
    elif tier == "LOW_FALLBACK_RESCUE":
        confidence_label = "low"
        confidence_score = 0.5
        auto_eligible = False
    else:
        confidence_label = "uncertain"
        confidence_score = 0.0
        auto_eligible = False

    answer_val = solver_res.canonical_key if is_ok and solver_res.canonical_key else ""

    # Zero-Poison Rule: Cache ONLY high and medium confidence solutions
    if is_ok and tier in (
        "HIGH_BOTH_AGREE",
        "MEDIUM_TIEBREAKER_AGREE",
        "MEDIUM_SEARXNG_GROUNDED",
        "USER_VERIFIED_OVERRIDE",
    ):
        cache_solution(
            subject=req.subject,
            q_type=req.q_type,
            question=req.question,
            options=req.options,
            solver_res=solver_res,
        )

    return SolveResponse(
        status="ok" if is_ok else "uncertain",
        q_type=req.q_type,
        answer=answer_val,
        selected_index=solver_res.selected_index,
        selected_text=solver_res.selected_text,
        permutation_indices=solver_res.permutation_indices,
        ordered_texts=solver_res.ordered_texts,
        reason=solver_res.reason or "",
        confidence_tier=tier,
        confidence_label=confidence_label,
        confidence_score=confidence_score,
        auto_eligible=auto_eligible,
        cache_hit=False,
        latency_ms=round(solver_res.latency_ms, 2),
        searxng_used=solver_res.searxng_used,
        search_sources=solver_res.search_sources,
    )


@app.post("/feedback", response_model=FeedbackResponse)
async def submit_feedback(req: FeedbackRequest) -> FeedbackResponse:
    """
    Process user feedback on wrong model answers.
    - Case A (no correct_answer): Evicts entry from solve_cache and logs to wrong_answers.
    - Case B (correct_answer provided): Overrides solve_cache with USER_VERIFIED_OVERRIDE,
      logs to wrong_answers, and optionally exports deduplicated question to questions.csv.
    """
    action, cache_key = record_wrong_answer(
        subject=req.subject,
        q_type=req.q_type,
        question=req.question,
        options=req.options,
        wrong_model_answer=req.wrong_model_answer,
        correct_answer=req.correct_answer,
        confidence_tier_at_failure=req.confidence_tier_at_failure,
        notes=req.notes,
    )

    csv_exported = False
    csv_row_id = None

    if req.export_to_csv and req.correct_answer is not None:
        try:
            csv_exported, csv_row_id = save_or_update_question_csv(
                subject=req.subject,
                q_type=req.q_type,
                question=req.question,
                options=req.options,
                correct_answer=req.correct_answer,
            )
        except Exception:
            csv_exported = False

    return FeedbackResponse(
        status="ok",
        action=action,
        cache_key=cache_key,
        csv_exported=csv_exported,
        csv_row_id=csv_row_id,
    )


@app.get("/feedback")
async def get_feedback_endpoint(only_with_correction: bool = False) -> Dict[str, Any]:
    """Retrieve logged wrong answers and summary counts."""
    items = get_wrong_answers(only_with_correction=only_with_correction)
    stats = get_cache_stats()
    return {
        "status": "ok",
        "total_wrong": len(items),
        "wrong_answers_count": stats.get("wrong_answers_count", 0),
        "user_overrides_count": stats.get("user_overrides_count", 0),
        "items": items,
    }

