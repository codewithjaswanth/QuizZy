"""Phase 0 Evaluation Runner for QuizZy."""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.core.llm_client import (
    SolverResponse,
    check_models,
    load_models_config,
    solve_question,
)
from backend.core.normalizer import (
    NormalizationError,
    NormalizedAnswer,
    grade_answer,
    normalize_answer,
    normalize_mcq_answer,
    normalize_order_answer,
    normalize_text_answer,
    parse_options,
)
from backend.core.parser import ParseError, parse_llm_response
from backend.core.prompts import build_prompt_messages, build_user_prompt


def run_self_test() -> bool:
    """
    Offline deterministic unit tests (Zero Network / Zero API Keys).
    Validates synthetic indexing, order permutations, mcq normalization,
    text normalization, ground-truth grading, parse validation, and <think> stripping.
    """
    print("=" * 70)
    print("RUNNING OFFLINE DETERMINISTIC SELF-TEST (Zero Network / Zero Keys)")
    print("=" * 70)

    # 0. Verify httpx availability in evaluation runner
    print("\n[Test 0] Checking httpx Library Availability...")
    assert hasattr(httpx, "AsyncClient"), "httpx.AsyncClient must be available"
    print("  -> Passed httpx library check.")

    # 1. Unlabelled 4-block order array -> synthetic A,B,C,D -> ["C","A","D","B"]
    print("\n[Test 1] Order Normalization & Synthetic Indexing...")
    sample_blocks = ["First block", "Second block", "Third block", "Fourth block"]
    # Synthetic mapping: A: First, B: Second, C: Third, D: Fourth
    # Input: ["C", "A", "D", "B"]
    norm_order = normalize_order_answer(["C", "A", "D", "B"], sample_blocks)
    assert norm_order.canonical_key == "C,A,D,B", f"Expected 'C,A,D,B', got '{norm_order.canonical_key}'"
    assert norm_order.permutation_indices == [2, 0, 3, 1], f"Expected [2, 0, 3, 1], got {norm_order.permutation_indices}"
    assert norm_order.ordered_texts == ["Third block", "First block", "Fourth block", "Second block"], \
        f"Ordered texts mismatch: {norm_order.ordered_texts}"
    print("  -> Passed synthetic letter array to permutation indices and ordered texts.")

    # Test string input formats: 'C, A, D, B', 'CADB', 'C-A-D-B'
    for s_fmt in ["C, A, D, B", "CADB", "C-A-D-B", "C -> A -> D -> B"]:
        res_str = normalize_order_answer(s_fmt, sample_blocks)
        assert res_str.canonical_key == "C,A,D,B", f"Failed for format '{s_fmt}'"
        assert res_str.permutation_indices == [2, 0, 3, 1]
    print("  -> Passed string formats ('C, A, D, B', 'CADB', 'C-A-D-B').")

    # Test if LLM returns array of full option strings in target order
    full_text_array = ["Third block", "First block", "Fourth block", "Second block"]
    res_full = normalize_order_answer(full_text_array, sample_blocks)
    assert res_full.canonical_key == "C,A,D,B"
    assert res_full.permutation_indices == [2, 0, 3, 1]
    print("  -> Passed mapping full option text array back to synthetic letters.")

    # 2. Ground-truth grading for order using both "C,A,D,B" and JSON array
    print("\n[Test 2] Order Ground-Truth Grading Flexibility...")
    assert grade_answer(norm_order, "C,A,D,B", "order", sample_blocks) is True
    assert grade_answer(norm_order, "c, a, d, b", "order", sample_blocks) is True
    json_exp = json.dumps(["Third block", "First block", "Fourth block", "Second block"])
    assert grade_answer(norm_order, json_exp, "order", sample_blocks) is True
    assert grade_answer(norm_order, "A,B,C,D", "order", sample_blocks) is False
    print("  -> Passed grading with synthetic letters and target JSON text arrays.")

    # 3. Ground-truth grading for MCQ using both synthetic letter and full text
    print("\n[Test 3] MCQ Normalization & Grading Flexibility...")
    mcq_options = ["Ribosome", "Mitochondrion", "Nucleus", "Endoplasmic reticulum"]
    norm_mcq_b = normalize_mcq_answer("B", mcq_options)
    assert norm_mcq_b.canonical_key == "B"
    assert norm_mcq_b.selected_index == 1
    assert norm_mcq_b.selected_text == "Mitochondrion"

    # Grading with letter 'B'
    assert grade_answer(norm_mcq_b, "B", "mcq", mcq_options) is True
    assert grade_answer(norm_mcq_b, "b", "mcq", mcq_options) is True
    # Grading with full text
    assert grade_answer(norm_mcq_b, "Mitochondrion", "mcq", mcq_options) is True
    assert grade_answer(norm_mcq_b, "mitochondrion", "mcq", mcq_options) is True
    assert grade_answer(norm_mcq_b, "Nucleus", "mcq", mcq_options) is False

    # LLM outputs full text instead of letter
    recovered = normalize_mcq_answer("Mitochondrion", mcq_options)
    assert recovered.canonical_key == "B"
    assert recovered.selected_index == 1
    # LLM outputs 'Option B.'
    recovered_dot = normalize_mcq_answer("Option B.", mcq_options)
    assert recovered_dot.canonical_key == "B"
    print("  -> Passed MCQ letter & full text normalization and dual-format grading.")

    # 4. Text normalization: articles, punctuation, case folding, numbers, booleans, synonyms
    print("\n[Test 4] Text Normalization & Grading...")
    assert normalize_text_answer("The Mitochondrion") == "mitochondrion"
    assert normalize_text_answer("  a cat!  ") == "cat"
    assert normalize_text_answer("an Apple.") == "apple"
    assert normalize_text_answer("1,000.0") == "1000"
    assert normalize_text_answer(" 10.00 ") == "10"
    assert normalize_text_answer("True") == "true"
    assert normalize_text_answer("F") == "false"

    norm_text_gold = normalize_answer("text", " Gold ", [])
    assert norm_text_gold.canonical_key == "gold"
    # Pipe-separated synonyms 'Au|gold'
    assert grade_answer(norm_text_gold, "Au|gold", "text", []) is True
    norm_text_au = normalize_answer("text", "au", [])
    assert grade_answer(norm_text_au, "Au|gold", "text", []) is True
    norm_text_silver = normalize_answer("text", "silver", [])
    assert grade_answer(norm_text_silver, "Au|gold", "text", []) is False
    print("  -> Passed text NFKC, articles, numbers (1,000.0->1000), and synonym grading.")

    # 5. Rejection of invalid permutations and malformed JSON
    print("\n[Test 5] Rejection of Invalid Permutations & Malformed JSON...")
    try:
        normalize_order_answer("A,A,B,C", sample_blocks)
        assert False, "Should have rejected duplicate permutation 'A,A,B,C'"
    except NormalizationError:
        pass

    try:
        normalize_order_answer("A,B,E,D", sample_blocks)
        assert False, "Should have rejected out-of-range letter 'E'"
    except NormalizationError:
        pass

    try:
        normalize_order_answer(["A", "B"], sample_blocks)
        assert False, "Should have rejected incomplete permutation"
    except NormalizationError:
        pass

    try:
        parse_llm_response("Not json at all")
        assert False, "Should have rejected non-JSON"
    except ParseError:
        pass

    try:
        parse_llm_response('{"result": "B"}')
        assert False, "Should have rejected missing answer/reason"
    except ParseError:
        pass

    try:
        parse_llm_response('{"answer": "", "reason": "none"}')
        assert False, "Should have rejected empty answer"
    except ParseError:
        pass

    # Markdown code fence stripping
    fenced = '```json\n{"answer": "B", "reason": "Because of mitochondria"}\n```'
    parsed = parse_llm_response(fenced)
    assert parsed.answer == "B"
    assert parsed.reason == "Because of mitochondria"
    print("  -> Passed all validation and defensive error rejection assertions.")

    # 6. Hardened reasoning models test (<think>...</think> stripping)
    print("\n[Test 6] Reasoning Model <think> Tag Stripping...")
    think_closed = "<think>Let me analyze the question carefully. Mitochondria is B.</think>\n```json\n{\"answer\": \"B\", \"reason\": \"Mitochondria powerhouse\"}\n```"
    parsed_think_closed = parse_llm_response(think_closed)
    assert parsed_think_closed.answer == "B"
    assert parsed_think_closed.reason == "Mitochondria powerhouse"

    think_unclosed = "<think>We need to solve this step by step. Option B is correct.\n{\"answer\": \"B\", \"reason\": \"Mitochondria powerhouse\"}"
    parsed_think_unclosed = parse_llm_response(think_unclosed)
    assert parsed_think_unclosed.answer == "B"
    assert parsed_think_unclosed.reason == "Mitochondria powerhouse"
    print("  -> Passed closed and unclosed <think> tag stripping.")

    # 7. Phase 5 Drift Comparison & Dataset Merging Logic
    print("\n[Test 7] Phase 5 Drift Comparison & Dataset Merging Logic...")
    dummy_history_dir = PROJECT_ROOT / "eval" / "results" / "temp_test_drift"
    dummy_history_dir.mkdir(parents=True, exist_ok=True)
    try:
        prior_report = {
            "overall_accuracy_pct": 80.0,
            "latency_percentiles_ms": {"p95": 1200.0},
            "questions": [
                {"id": "Q1", "is_correct": True},
                {"id": "Q2", "is_correct": True},
            ],
        }
        with open(dummy_history_dir / "eval_20260101_120000.json", "w", encoding="utf-8") as f:
            json.dump(prior_report, f)

        current_report = {
            "overall_accuracy_pct": 90.0,
            "latency_percentiles_ms": {"p95": 950.0},
            "questions": [
                {"id": "Q1", "is_correct": True},
                {"id": "Q2", "is_correct": False},
                {"id": "Q3", "is_correct": True},
            ],
        }
        drift_res = compare_historical_drift(current_report, dummy_history_dir)
        assert drift_res is not None
        assert drift_res["accuracy_delta"] == 10.0
        assert drift_res["p95_delta_ms"] == -250.0
        assert drift_res["new_regressions"] == ["Q2"]
        print("  -> Passed drift comparison, latency delta, and regression detection.")
    finally:
        for f in dummy_history_dir.glob("*.json"):
            f.unlink()
        dummy_history_dir.rmdir()

    print("\n" + "=" * 70)
    print("ALL OFFLINE DETERMINISTIC SELF-TESTS PASSED (100% SUCCESS)")
    print("=" * 70)
    return True


def compare_historical_drift(current_eval: dict, history_dir: Path) -> Optional[dict]:
    """
    Finds the most recent prior evaluation report in history_dir (eval_*.json)
    and computes accuracy delta, p95 latency delta, and newly regressed question IDs.
    """
    if not history_dir.is_dir():
        return None

    history_files = sorted(
        [f for f in history_dir.glob("eval_*.json") if f.is_file()],
        key=lambda p: p.name,
    )
    if not history_files:
        return None

    latest_prior_file = history_files[-1]
    try:
        with open(latest_prior_file, "r", encoding="utf-8") as f:
            prior_data = json.load(f)
    except Exception as e:
        print(f"Warning: Failed to read prior history file {latest_prior_file}: {e}")
        return None

    prior_acc = float(prior_data.get("overall_accuracy_pct", 0.0))
    prior_p95 = float(prior_data.get("latency_percentiles_ms", {}).get("p95", 0.0))
    current_acc = float(current_eval.get("overall_accuracy_pct", 0.0))
    current_p95 = float(current_eval.get("latency_percentiles_ms", {}).get("p95", 0.0))

    prior_correct_ids = {
        q.get("id") for q in prior_data.get("questions", []) if q.get("is_correct")
    }

    current_questions = current_eval.get("questions", [])
    new_regressions = [
        q.get("id")
        for q in current_questions
        if not q.get("is_correct") and q.get("id") in prior_correct_ids
    ]

    return {
        "prior_file": latest_prior_file.name,
        "prior_accuracy_pct": prior_acc,
        "current_accuracy_pct": current_acc,
        "accuracy_delta": round(current_acc - prior_acc, 2),
        "prior_p95_ms": prior_p95,
        "current_p95_ms": current_p95,
        "p95_delta_ms": round(current_p95 - prior_p95, 2),
        "new_regressions": new_regressions,
    }


def merge_wrong_answers(rows: List[dict], db_path: Optional[str] = None) -> List[dict]:
    """
    Merges corrected items from the SQLite wrong_answers table into the evaluation dataset.
    Deduplicates against existing rows (by normalized question + sorted options).
    Marks all rows originating from or present in wrong_answers with 'from_wrong_answers': True.
    """
    from backend.cache import get_wrong_answers
    try:
        wrong_answers = get_wrong_answers(only_with_correction=True, db_path=db_path)
    except Exception as e:
        print(f"Warning: Could not fetch wrong answers from SQLite cache: {e}")
        return rows

    if not wrong_answers:
        return rows

    def norm_q_opts(q: str, opts_raw: Any) -> Tuple[str, Tuple[str, ...]]:
        opts = parse_options(opts_raw) if isinstance(opts_raw, str) else list(opts_raw or [])
        clean_opts = tuple(sorted([o.strip().lower() for o in opts]))
        return (q.strip().lower(), clean_opts)

    existing_signatures = set()
    for r in rows:
        existing_signatures.add(norm_q_opts(r.get("question", ""), r.get("options_json", "[]")))

    merged_rows = list(rows)
    for wa in wrong_answers:
        wa_sig = norm_q_opts(wa.get("question", ""), wa.get("options_json", "[]"))
        if wa_sig in existing_signatures:
            for r in merged_rows:
                if norm_q_opts(r.get("question", ""), r.get("options_json", "[]")) == wa_sig:
                    r["from_wrong_answers"] = True
        else:
            new_row = {
                "id": f"WRONG_{wa['id']}",
                "subject": wa.get("subject", "General"),
                "q_type": wa.get("q_type", "mcq"),
                "question": wa.get("question", ""),
                "options_json": wa.get("options_json", "[]"),
                "expected_answer": wa.get("correct_canonical_json", ""),
                "from_wrong_answers": True,
            }
            merged_rows.append(new_row)
            existing_signatures.add(wa_sig)

    return merged_rows


def calculate_percentile(data: List[float], percentile: float) -> float:
    """Calculate percentile from a list of floats."""
    if not data:
        return 0.0
    sorted_data = sorted(data)
    k = (len(sorted_data) - 1) * (percentile / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_data[int(k)]
    d0 = sorted_data[int(f)] * (c - k)
    d1 = sorted_data[int(c)] * (k - f)
    return d0 + d1


async def run_evaluation(
    input_path: str,
    cooldown_ms: int,
    include_samples: bool,
    config_path: Optional[str] = None,
    is_weekly: bool = False,
) -> int:
    """Run full evaluation suite over CSV dataset and output calibration report."""
    if is_weekly:
        print("=" * 75)
        print("RUNNING WEEKLY RE-EVALUATION PIPELINE")
        print("Step 1: Checking live model connectivity and deprecations...")
        print("=" * 75)
        models_ok = await check_models(config_path)
        if not models_ok:
            print("ERROR: One or more configured models failed check_models. Aborting weekly re-evaluation.")
            return 1

    csv_file = Path(input_path)
    if not csv_file.is_file():
        print(f"Error: input CSV not found at '{csv_file}'")
        return 1

    config = load_models_config(config_path)

    # Read CSV rows
    rows: List[dict] = []
    with open(csv_file, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows.append(r)

    if not rows:
        print(f"Error: No rows found in '{csv_file}'")
        return 1

    has_real_rows = any(not r.get("id", "").startswith("SAMPLE_") for r in rows)

    # Filter rows based on --include-samples
    eval_rows: List[dict] = []
    for r in rows:
        is_sample = r.get("id", "").startswith("SAMPLE_")
        if is_sample and has_real_rows and not include_samples and not is_weekly:
            continue
        eval_rows.append(r)

    # In weekly mode, merge corrected items from SQLite wrong_answers table
    if is_weekly:
        eval_rows = merge_wrong_answers(eval_rows)

    print(f"\nLoaded {len(rows)} total rows from {csv_file.name}.")
    print(f"Evaluating {len(eval_rows)} rows (is_weekly={is_weekly}, include_samples={include_samples}, cooldown_ms={cooldown_ms}ms)...")
    print("-" * 75)

    results: List[dict] = []
    total_eval = len(eval_rows)

    async with httpx.AsyncClient() as client:
        for idx, row in enumerate(eval_rows, start=1):
            qid = row.get("id", f"ROW_{idx}")
            subj = row.get("subject", "General")
            q_type = row.get("q_type", "mcq").strip().lower()
            q_text = row.get("question", "")
            opts_raw = row.get("options_json", "[]")
            expected_raw = row.get("expected_answer", "")

            options = parse_options(opts_raw)

            print(f"[{idx}/{total_eval}] {qid} ({subj} | {q_type}): {q_text[:45]}...", end=" ", flush=True)

            solver_res: SolverResponse = await solve_question(
                subject=subj,
                q_type=q_type,
                question=q_text,
                options=options,
                config=config,
                client=client,
            )

            # Grade answer
            is_correct = False
            if solver_res.status == "OK" and solver_res.canonical_key:
                temp_norm = NormalizedAnswer(
                    canonical_key=solver_res.canonical_key,
                    selected_index=solver_res.selected_index,
                    selected_text=solver_res.selected_text,
                    permutation_indices=solver_res.permutation_indices,
                    ordered_texts=solver_res.ordered_texts,
                )
                is_correct = grade_answer(temp_norm, expected_raw, q_type, options)

            mark = "CORRECT" if is_correct else "INCORRECT"
            print(f"-> {solver_res.confidence_tier} ({solver_res.latency_ms:.0f}ms) [{mark}]")

            results.append({
                "id": qid,
                "is_sample": qid.startswith("SAMPLE_"),
                "from_wrong_answers": bool(row.get("from_wrong_answers")),
                "subject": subj,
                "q_type": q_type,
                "question": q_text,
                "options": options,
                "expected_answer": expected_raw,
                "solver_response": solver_res.model_dump(),
                "is_correct": is_correct,
            })

            # Cooldown sleep to prevent free tier rate limits (not counted in latency metrics)
            if idx < total_eval and cooldown_ms > 0:
                await asyncio.sleep(cooldown_ms / 1000.0)

    # Generate Evaluation & Calibration Report
    print("\n" + "=" * 75)
    print("PHASE 0 EVALUATION & CALIBRATION REPORT" if not is_weekly else "WEEKLY RE-EVALUATION REPORT")
    print("=" * 75)

    total_q = len(results)
    correct_q = sum(1 for r in results if r["is_correct"])
    overall_acc = (correct_q / total_q * 100.0) if total_q else 0.0

    print(f"\nOverall Summary: {correct_q}/{total_q} Correct ({overall_acc:.1f}% Accuracy)")

    # Breakdown by q_type
    print("\n--- Accuracy by Question Type ---")
    q_types = sorted(list(set(r["q_type"] for r in results)))
    for qt in q_types:
        qt_items = [r for r in results if r["q_type"] == qt]
        qt_correct = sum(1 for r in qt_items if r["is_correct"])
        qt_acc = (qt_correct / len(qt_items) * 100.0) if qt_items else 0.0
        print(f"  {qt.upper():<8}: {qt_correct}/{len(qt_items)} ({qt_acc:.1f}%)")

    # Breakdown by subject
    print("\n--- Accuracy by Subject ---")
    subjects = sorted(list(set(r["subject"] for r in results)))
    for s in subjects:
        s_items = [r for r in results if r["subject"] == s]
        s_correct = sum(1 for r in s_items if r["is_correct"])
        s_acc = (s_correct / len(s_items) * 100.0) if s_items else 0.0
        print(f"  {s:<22}: {s_correct}/{len(s_items)} ({s_acc:.1f}%)")

    # Empirical Confidence Calibration Table
    print("\n--- Empirical Confidence Calibration Table ---")
    print(f"  {'Confidence Tier':<30} | {'Count':<6} | {'Correct':<8} | {'Accuracy':<10}")
    print("  " + "-" * 62)
    tiers = [
        "HIGH_BOTH_AGREE",
        "MEDIUM_TIEBREAKER_AGREE",
        "MEDIUM_SEARXNG_GROUNDED",
        "LOW_FALLBACK_RESCUE",
        "UNCERTAIN_BUDGET_EXHAUSTED",
        "UNCERTAIN_NO_AGREEMENT",
        "UNCERTAIN_PRIMARY_FAILURE",
    ]
    calibration_data = {}
    for tier in tiers:
        tier_items = [r for r in results if r["solver_response"]["confidence_tier"] == tier]
        t_count = len(tier_items)
        t_correct = sum(1 for r in tier_items if r["is_correct"])
        t_acc = (t_correct / t_count * 100.0) if t_count else 0.0
        calibration_data[tier] = {
            "count": t_count,
            "correct": t_correct,
            "accuracy_pct": round(t_acc, 2),
        }
        print(f"  {tier:<30} | {t_count:<6} | {t_correct:<8} | {t_acc:.1f}%")

    # Dedicated Previously Wrong Recovery Rate Metric
    wrong_items = [r for r in results if r.get("from_wrong_answers")]
    total_previously_wrong = len(wrong_items)
    recovered_count = sum(1 for r in wrong_items if r["is_correct"])
    recovery_rate = (recovered_count / total_previously_wrong * 100.0) if total_previously_wrong else 0.0

    if is_weekly or total_previously_wrong > 0:
        print("\n--- Previously Wrong Recovery Rate ---")
        print(f"  Total Previously Wrong Tested : {total_previously_wrong}")
        print(f"  Recovered by Live Pipeline   : {recovered_count}")
        print(f"  Recovery Rate                 : {recovery_rate:.1f}%")

    # Latency Distribution (with 3000ms penalties applied)
    latencies = [r["solver_response"]["latency_ms"] for r in results]
    p50 = calculate_percentile(latencies, 50)
    p90 = calculate_percentile(latencies, 90)
    p95 = calculate_percentile(latencies, 95)
    max_lat = max(latencies) if latencies else 0.0

    print("\n--- Wall-Clock Latency Distribution (with timeout penalties) ---")
    print(f"  p50 Latency : {p50:.1f} ms")
    print(f"  p90 Latency : {p90:.1f} ms")
    print(f"  p95 Latency : {p95:.1f} ms (Target: <= 3000 ms)")
    print(f"  Max Latency : {max_lat:.1f} ms")

    # Rates & Errors
    disagreements = 0
    fallback_triggered = 0
    pri_a_errors = 0
    pri_b_errors = 0
    fb_errors = 0

    for r in results:
        resp = r["solver_response"]
        models = resp.get("models_called", [])
        if "fallback" in models:
            fallback_triggered += 1

        details = resp.get("agreement_details", {})
        det_a = details.get("primary_a", {})
        det_b = details.get("primary_b", {})
        det_fb = details.get("fallback", {})

        if det_a.get("error"):
            pri_a_errors += 1
        if det_b.get("error"):
            pri_b_errors += 1
        if det_fb.get("error"):
            fb_errors += 1

        if det_a.get("canonical_key") != det_b.get("canonical_key") or not det_a.get("success") or not det_b.get("success"):
            disagreements += 1

    disagree_rate = (disagreements / total_q * 100.0) if total_q else 0.0
    fb_rate = (fallback_triggered / total_q * 100.0) if total_q else 0.0

    print("\n--- Operational Rates & Reliability ---")
    print(f"  Primary Disagreement Rate : {disagree_rate:.1f}%")
    print(f"  Fallback Trigger Rate     : {fb_rate:.1f}%")
    print(f"  Primary A Errors/Timeouts : {pri_a_errors}")
    print(f"  Primary B Errors/Timeouts : {pri_b_errors}")
    print(f"  Fallback Errors/Timeouts  : {fb_errors}")

    # Final Decision Gate
    non_sample_count = sum(1 for r in results if not r["is_sample"])
    print("\n" + "=" * 75)
    verdict = ""
    if non_sample_count < 20:
        verdict = f"DECISION: INSUFFICIENT_DATA (need >= 20 real non-sample questions, got {non_sample_count})"
    elif overall_acc >= 90.0 and p95 <= 3000.0:
        verdict = f"DECISION: GO (Accuracy {overall_acc:.1f}% >= 90%, p95 {p95:.0f}ms <= 3000ms)"
    else:
        failing = []
        if overall_acc < 90.0:
            failing.append(f"Accuracy {overall_acc:.1f}% < 90.0%")
        if p95 > 3000.0:
            failing.append(f"p95 latency {p95:.0f}ms > 3000ms")
        verdict = f"DECISION: NO-GO ({', '.join(failing)})"

    print(verdict)
    print("=" * 75)

    # Save to eval/results/latest_eval.json and eval/results/history/
    results_dir = PROJECT_ROOT / "eval" / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    history_dir = results_dir / "history"
    history_dir.mkdir(parents=True, exist_ok=True)
    out_file = results_dir / "latest_eval.json"

    eval_export = {
        "timestamp": time.time(),
        "is_weekly": is_weekly,
        "total_evaluated": total_q,
        "non_sample_evaluated": non_sample_count,
        "overall_accuracy_pct": round(overall_acc, 2),
        "latency_percentiles_ms": {
            "p50": round(p50, 2),
            "p90": round(p90, 2),
            "p95": round(p95, 2),
            "max": round(max_lat, 2),
        },
        "disagreement_rate_pct": round(disagree_rate, 2),
        "fallback_trigger_rate_pct": round(fb_rate, 2),
        "model_error_counts": {
            "primary_a": pri_a_errors,
            "primary_b": pri_b_errors,
            "fallback": fb_errors,
        },
        "confidence_calibration": calibration_data,
        "previously_wrong_metrics": {
            "total_previously_wrong": total_previously_wrong,
            "recovered_count": recovered_count,
            "recovery_rate_pct": round(recovery_rate, 2),
        },
        "verdict": verdict,
        "questions": results,
    }

    # Historical Drift Comparison
    drift = compare_historical_drift(eval_export, history_dir)
    if drift:
        print("\n" + "=" * 75)
        print("WEEKLY DRIFT & REGRESSION SUMMARY")
        print("=" * 75)
        print(f"  Compared against prior:    {drift['prior_file']}")
        print(f"  Prior Overall Accuracy:    {drift['prior_accuracy_pct']:.2f}%")
        print(f"  Current Overall Accuracy:  {drift['current_accuracy_pct']:.2f}%")
        print(f"  Accuracy Delta:            {drift['accuracy_delta']:+.2f}%")
        print(f"  Prior p95 Latency:         {drift['prior_p95_ms']:.1f} ms")
        print(f"  Current p95 Latency:       {drift['current_p95_ms']:.1f} ms")
        print(f"  p95 Latency Delta:         {drift['p95_delta_ms']:+.1f} ms")
        reg_text = ", ".join(drift["new_regressions"]) if drift["new_regressions"] else "None (0 regressions)"
        print(f"  New Regressions:           {len(drift['new_regressions'])} ({reg_text})")
        print("=" * 75)
        eval_export["drift_comparison"] = drift
    elif is_weekly:
        print("\n[Weekly Re-Eval] No prior historical snapshot found in history/ for drift comparison.")

    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(eval_export, f, indent=2)

    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    archive_file = history_dir / f"eval_{timestamp_str}.json"
    with open(archive_file, "w", encoding="utf-8") as f:
        json.dump(eval_export, f, indent=2)

    print(f"\nDetailed evaluation report saved to: {out_file.relative_to(PROJECT_ROOT)}")
    print(f"Timestamped archive saved to: {archive_file.relative_to(PROJECT_ROOT)}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="QuizZy Phase 0 & Weekly Model Evaluation Harness")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run offline deterministic unit tests (zero network/keys required) and exit",
    )
    parser.add_argument(
        "--check-models",
        action="store_true",
        help="Verify model slugs and live connectivity to Groq and OpenRouter and exit",
    )
    parser.add_argument(
        "--weekly",
        action="store_true",
        help="Run weekly re-evaluation pipeline (check models, merge wrong answers, track recovery & drift)",
    )
    parser.add_argument(
        "--input",
        type=str,
        default="questions.csv",
        help="Path to evaluation CSV file (default: questions.csv)",
    )
    parser.add_argument(
        "--cooldown-ms",
        type=int,
        default=2500,
        help="Cooldown between questions in milliseconds to prevent rate limiting (default: 2500)",
    )
    parser.add_argument(
        "--include-samples",
        action="store_true",
        help="Include SAMPLE_ rows in evaluation even when real rows exist",
    )
    parser.add_argument(
        "--config",
        type=str,
        default="models.json",
        help="Path to models config JSON (default: models.json)",
    )

    args = parser.parse_args()

    if args.self_test:
        success = run_self_test()
        sys.exit(0 if success else 1)

    if args.check_models:
        success = asyncio.run(check_models(args.config))
        sys.exit(0 if success else 1)

    # Run evaluation (regular or weekly)
    exit_code = asyncio.run(
        run_evaluation(
            input_path=args.input,
            cooldown_ms=args.cooldown_ms,
            include_samples=args.include_samples,
            config_path=args.config,
            is_weekly=args.weekly,
        )
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
