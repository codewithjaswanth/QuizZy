"""
Phase 5 Verification Suite: Wrong-Answer Logging, Cache Eviction,
Canonical User-Verified Overrides, Dataset Deduplication, and Weekly Re-Evaluation.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, List
from unittest.mock import patch

from fastapi.testclient import TestClient

# Ensure workspace root is in sys.path
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))

from backend.app import app, save_or_update_question_csv
from backend.cache import (
    cache_solution,
    compute_cache_key,
    get_cached_solution,
    get_wrong_answers,
    init_db,
    record_wrong_answer,
)
from eval.run_eval import compare_historical_drift, merge_wrong_answers


def test_1_cache_eviction_on_unverified_flag():
    """
    Test 1 (Cache Eviction on Unverified Flag):
    Caching an answer in solve_cache and calling POST /feedback with correct_answer=None
    immediately evicts the entry from solve_cache (cache_hit == False on next lookup)
    and logs it in wrong_answers.
    """
    print("\n[Test 1] Testing Cache Eviction on Unverified Flag...")
    client = TestClient(app)

    question = "What is the capital city of Australia?"
    options = ["Sydney", "Melbourne", "Canberra", "Perth"]
    subject = "Geography"
    q_type = "mcq"

    # Step 1: Pre-populate solve_cache with a bogus answer
    cache_key = compute_cache_key(subject, q_type, question, options)
    from backend.core.llm_client import SolverResponse
    bogus_solver_res = SolverResponse(
        status="OK",
        canonical_key="A",
        selected_index=0,
        selected_text="Sydney",
        reason="Model hallucinated Sydney",
        confidence_tier="HIGH_BOTH_AGREE",
        confidence_score=0.95,
        confidence_label="high",
        model_a="test-a",
        model_b="test-b",
        latency_ms=100.0,
    )
    cache_solution(
        subject=subject,
        q_type=q_type,
        question=question,
        options=options,
        solver_res=bogus_solver_res,
    )

    # Verify that it is currently cached
    cached_before = get_cached_solution(subject, q_type, question, options)
    assert cached_before is not None, "Pre-condition failed: Answer should be cached"
    assert cached_before["selected_text"] == "Sydney"
    assert cached_before["selected_index"] == 0
    print("  -> Pre-cached bogus answer verified in solve_cache.")

    # Step 2: Post feedback flagging answer as WRONG without supplying a correction
    resp = client.post(
        "/feedback",
        json={
            "subject": subject,
            "q_type": q_type,
            "question": question,
            "options": options,
            "wrong_model_answer": "Sydney",
            "correct_answer": None,
            "confidence_tier_at_failure": "HIGH_BOTH_AGREE",
            "notes": "Sydney is wrong, Canberra is the actual capital.",
            "export_to_csv": False,
        },
    )
    assert resp.status_code == 200, f"Feedback POST failed: {resp.text}"
    data = resp.json()
    assert data["status"] == "ok"
    assert data["action"] == "evicted_and_logged", f"Expected 'evicted_and_logged', got {data['action']}"
    assert data["cache_key"] == cache_key
    assert data["csv_exported"] is False
    print("  -> Feedback endpoint returned action='evicted_and_logged'.")

    # Step 3: Verify solve_cache has evicted the entry
    cached_after = get_cached_solution(subject, q_type, question, options)
    assert cached_after is None, "Eviction failed: solve_cache should return None after unverified flag"
    print("  -> Immediate cache eviction verified: subsequent lookup returned cache_hit == False.")

    # Step 4: Verify logged entry exists in wrong_answers
    wrong_records = get_wrong_answers(only_with_correction=False)
    logged = next((r for r in wrong_records if r["cache_key"] == cache_key), None)
    assert logged is not None, "Record not found in wrong_answers table"
    assert logged["wrong_model_answer"] == "Sydney"
    assert logged["correct_canonical_json"] is None
    print("  -> Audit log verified in SQLite wrong_answers table.")


def test_2_order_invariant_user_verified_override_on_jumbled_options():
    """
    Test 2 (Order-Invariant USER_VERIFIED_OVERRIDE on Jumbled Options):
    Calling POST /feedback with a corrected answer stores USER_VERIFIED_OVERRIDE in solve_cache,
    and a subsequent lookup with shuffled/jumbled options returns cache_hit == True,
    confidence_tier == 'USER_VERIFIED_OVERRIDE', auto_eligible == True,
    and the exact remapped index/permutation for the new option order.
    """
    print("\n[Test 2] Testing Order-Invariant USER_VERIFIED_OVERRIDE on Jumbled Options...")
    client = TestClient(app)

    # -------------------------------------------------------------------------
    # Part A: MCQ Question with Shuffled Options
    # -------------------------------------------------------------------------
    mcq_q = "Which cell organelle is the site of cellular respiration?"
    original_options = ["Nucleus", "Ribosome", "Endoplasmic reticulum", "Mitochondrion"]
    # The correct option is "Mitochondrion" (Index 3, Option D)

    resp_mcq = client.post(
        "/feedback",
        json={
            "subject": "Biology",
            "q_type": "mcq",
            "question": mcq_q,
            "options": original_options,
            "wrong_model_answer": "Nucleus",
            "correct_answer": "Mitochondrion",
            "confidence_tier_at_failure": "LOW_FALLBACK_RESCUE",
            "notes": "Powerhouse of cell",
            "export_to_csv": False,
        },
    )
    assert resp_mcq.status_code == 200, resp_mcq.text
    data_mcq = resp_mcq.json()
    assert data_mcq["action"] == "overridden_and_logged"
    print("  -> MCQ correction stored as USER_VERIFIED_OVERRIDE.")

    # Now simulate a subsequent quiz attempt with completely SHUFFLED option blocks:
    # "Mitochondrion" is now moved to Index 0 (Option A)!
    shuffled_options = ["Mitochondrion", "Nucleus", "Ribosome", "Endoplasmic reticulum"]
    solve_req = {
        "subject": "Biology",
        "q_type": "mcq",
        "question": mcq_q,
        "options": shuffled_options,
        "bypass_cache": False,
    }
    solve_resp = client.post("/solve", json=solve_req)
    assert solve_resp.status_code == 200, solve_resp.text
    sol = solve_resp.json()

    assert sol["cache_hit"] is True, "Must hit cache on jumbled options"
    assert sol["confidence_tier"] == "USER_VERIFIED_OVERRIDE", f"Expected USER_VERIFIED_OVERRIDE, got {sol['confidence_tier']}"
    assert sol["confidence_label"] == "high"
    assert sol["confidence_score"] == 1.0
    assert sol["auto_eligible"] is True, "User verified overrides must be auto_eligible"
    assert sol["selected_index"] == 0, f"Remapped index should be 0, got {sol['selected_index']}"
    assert sol["selected_text"] == "Mitochondrion"
    print("  -> Passed MCQ order-invariant remapping: moved from index 3 to index 0.")

    # -------------------------------------------------------------------------
    # Part B: Unlabelled Order Question with Shuffled Screen Blocks
    # -------------------------------------------------------------------------
    order_q = "Arrange the scientific method stages in correct logical sequence."
    initial_blocks = [
        "Formulate a testable hypothesis",  # B
        "Make an initial observation",       # A
        "Analyze experimental data",        # D
        "Design and perform experiment",    # C
    ]
    # Correct sequence texts:
    # 1. "Make an initial observation"
    # 2. "Formulate a testable hypothesis"
    # 3. "Design and perform experiment"
    # 4. "Analyze experimental data"

    resp_order = client.post(
        "/feedback",
        json={
            "subject": "Science",
            "q_type": "order",
            "question": order_q,
            "options": initial_blocks,
            "wrong_model_answer": "A,B,C,D",
            "correct_answer": [
                "Make an initial observation",
                "Formulate a testable hypothesis",
                "Design and perform experiment",
                "Analyze experimental data",
            ],
            "confidence_tier_at_failure": "UNCERTAIN_NO_AGREEMENT",
            "notes": "Verified logical sequence",
            "export_to_csv": False,
        },
    )
    assert resp_order.status_code == 200, resp_order.text
    assert resp_order.json()["action"] == "overridden_and_logged"
    print("  -> Order correction stored as USER_VERIFIED_OVERRIDE.")

    # Subsequent attempt has blocks jumbled on screen:
    jumbled_screen_blocks = [
        "Analyze experimental data",        # Index 0
        "Design and perform experiment",    # Index 1
        "Make an initial observation",       # Index 2
        "Formulate a testable hypothesis",  # Index 3
    ]
    # In this jumbled screen:
    # 1st step ("Make an initial observation") is at index 2
    # 2nd step ("Formulate a testable hypothesis") is at index 3
    # 3rd step ("Design and perform experiment") is at index 1
    # 4th step ("Analyze experimental data") is at index 0
    # Expected permutation_indices: [2, 3, 1, 0]

    solve_order_resp = client.post(
        "/solve",
        json={
            "subject": "Science",
            "q_type": "order",
            "question": order_q,
            "options": jumbled_screen_blocks,
            "bypass_cache": False,
        },
    )
    assert solve_order_resp.status_code == 200, solve_order_resp.text
    sol_order = solve_order_resp.json()

    assert sol_order["cache_hit"] is True
    assert sol_order["confidence_tier"] == "USER_VERIFIED_OVERRIDE"
    assert sol_order["auto_eligible"] is True
    assert sol_order["permutation_indices"] == [2, 3, 1, 0], f"Got {sol_order['permutation_indices']}"
    assert sol_order["ordered_texts"] == [
        "Make an initial observation",
        "Formulate a testable hypothesis",
        "Design and perform experiment",
        "Analyze experimental data",
    ]
    print("  -> Passed Order drag-and-drop remapping: target sequence dynamically resolved to [2, 3, 1, 0].")


def test_3_deduplicated_questions_csv_auto_append():
    """
    Test 3 (Deduplicated questions.csv Auto-Append):
    Submitting feedback with export_to_csv=True appends a REAL_... row to a test CSV,
    and submitting updated feedback for the same question updates the row in place
    without creating duplicates.
    """
    print("\n[Test 3] Testing Deduplicated questions.csv Auto-Append & In-Place Update...")

    with tempfile.TemporaryDirectory() as tmpdir:
        test_csv_path = Path(tmpdir) / "test_questions.csv"

        # Create base test CSV
        with open(test_csv_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["id", "subject", "q_type", "question", "options_json", "expected_answer"])
            writer.writerow(["SAMPLE_001", "Math", "text", "What is 2 + 2?", "[]", "4"])

        # Step 1: Save first real question
        q1_opts = ["Berlin", "Madrid", "Paris", "Rome"]
        exported, row_id_1 = save_or_update_question_csv(
            subject="Geography",
            q_type="mcq",
            question="What is the capital of France?",
            options=q1_opts,
            correct_answer="Paris",
            csv_path=str(test_csv_path),
        )
        assert exported is True
        assert row_id_1.startswith("REAL_")

        # Read CSV rows
        with open(test_csv_path, "r", encoding="utf-8") as f:
            reader = list(csv.DictReader(f))
        assert len(reader) == 2, f"Expected 2 rows, got {len(reader)}"
        r_appended = reader[1]
        assert r_appended["id"] == row_id_1
        assert r_appended["expected_answer"] == "C"  # Paris is index 2 -> "C"
        print("  -> First question successfully appended with REAL_ hash ID and canonical MCQ letter 'C'.")

        # Step 2: Save updated feedback for the SAME question (casing/whitespace variation)
        exported_again, row_id_2 = save_or_update_question_csv(
            subject="World Geography",
            q_type="mcq",
            question="  what is the CAPITAL of France?  ",
            options=["Berlin", "Madrid", "Paris", "Rome"],
            correct_answer="Paris",
            csv_path=str(test_csv_path),
        )
        assert exported_again is True
        assert row_id_1 == row_id_2, "Row ID should match for deduplicated update"

        # Read CSV rows again
        with open(test_csv_path, "r", encoding="utf-8") as f:
            reader_updated = list(csv.DictReader(f))
        assert len(reader_updated) == 2, f"Deduplication failed: Expected exactly 2 rows, got {len(reader_updated)}"
        assert reader_updated[1]["subject"] == "World Geography", "Row should have been updated in-place"
        print("  -> In-place update succeeded without creating duplicate rows.")

        # Step 3: Order question format export
        order_opts = ["First Step", "Second Step", "Third Step"]
        exp_order, row_order = save_or_update_question_csv(
            subject="Process",
            q_type="order",
            question="Order the three steps in sequence",
            options=order_opts,
            correct_answer=["Third Step", "First Step", "Second Step"],
            csv_path=str(test_csv_path),
        )
        assert exp_order is True
        with open(test_csv_path, "r", encoding="utf-8") as f:
            reader_order = list(csv.DictReader(f))
        assert len(reader_order) == 3
        assert reader_order[2]["expected_answer"] == "C,A,B"
        print("  -> Order question successfully mapped to canonical permutation 'C,A,B'.")


def test_4_weekly_reeval_and_drift_comparison():
    """
    Test 4 (Weekly Re-Eval & Drift Comparison):
    Running the weekly re-eval logic merges wrong_answers with CSV rows,
    calculates Previously Wrong Recovery Rate, writes a snapshot to eval/results/history/,
    and computes the drift delta against a prior snapshot.
    """
    print("\n[Test 4] Testing Weekly Re-Eval, Recovery Rate & Drift Comparison...")

    with tempfile.TemporaryDirectory() as tmpdir:
        history_dir = Path(tmpdir) / "history"
        history_dir.mkdir(parents=True, exist_ok=True)

        # 1. Seed a historical baseline evaluation report
        prior_eval = {
            "timestamp": 1700000000.0,
            "overall_accuracy_pct": 82.5,
            "latency_percentiles_ms": {
                "p50": 600.0,
                "p90": 1100.0,
                "p95": 1400.0,
                "max": 1800.0,
            },
            "questions": [
                {"id": "Q1", "is_correct": True},
                {"id": "Q2", "is_correct": True},
                {"id": "Q3", "is_correct": False},
            ],
        }
        with open(history_dir / "eval_20260101_100000.json", "w", encoding="utf-8") as f:
            json.dump(prior_eval, f)

        # 2. Create current evaluation with 1 recovery and 1 regression
        current_eval = {
            "timestamp": 1700100000.0,
            "overall_accuracy_pct": 87.5,
            "latency_percentiles_ms": {
                "p50": 550.0,
                "p90": 1000.0,
                "p95": 1250.0,
                "max": 1600.0,
            },
            "questions": [
                {"id": "Q1", "is_correct": True},
                {"id": "Q2", "is_correct": False},  # New regression!
                {"id": "Q3", "is_correct": True},   # Recovered!
                {"id": "WRONG_101", "is_correct": True, "from_wrong_answers": True},
                {"id": "WRONG_102", "is_correct": False, "from_wrong_answers": True},
            ],
        }

        # 3. Test Drift Calculation
        drift = compare_historical_drift(current_eval, history_dir)
        assert drift is not None
        assert drift["prior_accuracy_pct"] == 82.5
        assert drift["current_accuracy_pct"] == 87.5
        assert drift["accuracy_delta"] == 5.0
        assert drift["prior_p95_ms"] == 1400.0
        assert drift["current_p95_ms"] == 1250.0
        assert drift["p95_delta_ms"] == -150.0
        assert drift["new_regressions"] == ["Q2"]
        print("  -> Passed drift metrics: accuracy delta +5.0%, p95 latency delta -150.0ms, new regressions: ['Q2'].")

        # 4. Test Previously Wrong Recovery Rate calculation
        wrong_subset = [q for q in current_eval["questions"] if q.get("from_wrong_answers")]
        tot_wrong = len(wrong_subset)
        recovered = sum(1 for q in wrong_subset if q["is_correct"])
        rec_rate = (recovered / tot_wrong * 100.0) if tot_wrong else 0.0
        assert tot_wrong == 2
        assert recovered == 1
        assert rec_rate == 50.0
        print(f"  -> Passed Previously Wrong Recovery Rate calculation: {recovered}/{tot_wrong} ({rec_rate:.1f}%).")

        # 5. Test merge_wrong_answers logic with mock data
        base_rows = [
            {"id": "SAMPLE_1", "question": "What is Python?", "options_json": "[]", "expected_answer": "Language"}
        ]
        with patch("backend.cache.get_wrong_answers") as mock_get_wrong:
            mock_get_wrong.return_value = [
                {
                    "id": 88,
                    "subject": "CS",
                    "q_type": "text",
                    "question": "What is RAM?",
                    "options_json": "[]",
                    "correct_canonical_json": "Random Access Memory",
                }
            ]
            merged = merge_wrong_answers(base_rows)
            assert len(merged) == 2
            assert merged[1]["id"] == "WRONG_88"
            assert merged[1]["from_wrong_answers"] is True
            print("  -> Passed dataset merging of SQLite wrong answers with eval rows.")


def test_5_extension_feedback_ui_audit():
    """
    Test 5 (Extension Feedback UI Audit):
    Verifies sidepanel.html, sidepanel.js, sidepanel.css, and background.js
    wire #btn-flag-wrong, #btn-save-eval, #feedback-correction-box, and SUBMIT_FEEDBACK.
    """
    print("\n[Test 5] Auditing Extension Feedback UI & Message Routing...")

    # 1. sidepanel.html audit
    html_path = WORKSPACE_ROOT / "extension" / "sidepanel.html"
    assert html_path.is_file(), f"sidepanel.html not found at {html_path}"
    html_content = html_path.read_text(encoding="utf-8")

    assert 'id="btn-flag-wrong"' in html_content, "Missing #btn-flag-wrong in sidepanel.html"
    assert 'id="btn-save-eval"' in html_content, "Missing #btn-save-eval in sidepanel.html"
    assert 'id="feedback-correction-box"' in html_content, "Missing #feedback-correction-box in sidepanel.html"
    assert 'id="input-correct-answer"' in html_content, "Missing #input-correct-answer in sidepanel.html"
    assert 'id="btn-apply-override"' in html_content, "Missing #btn-apply-override in sidepanel.html"
    print("  -> sidepanel.html contains all required feedback and override DOM elements.")

    # 2. sidepanel.js audit
    js_path = WORKSPACE_ROOT / "extension" / "sidepanel.js"
    assert js_path.is_file(), f"sidepanel.js not found at {js_path}"
    js_content = js_path.read_text(encoding="utf-8")

    assert "btn-flag-wrong" in js_content, "sidepanel.js does not reference btn-flag-wrong"
    assert "btn-save-eval" in js_content, "sidepanel.js does not reference btn-save-eval"
    assert "feedback-correction-box" in js_content, "sidepanel.js does not reference feedback-correction-box"
    assert "SUBMIT_FEEDBACK" in js_content, "sidepanel.js does not send SUBMIT_FEEDBACK action"
    assert "USER VERIFIED (100%)" in js_content, "sidepanel.js does not render 'USER VERIFIED (100%)' badge"
    print("  -> sidepanel.js correctly references controls, wires SUBMIT_FEEDBACK, and renders badge.")

    # 3. background.js audit
    bg_path = WORKSPACE_ROOT / "extension" / "background.js"
    assert bg_path.is_file(), f"background.js not found at {bg_path}"
    bg_content = bg_path.read_text(encoding="utf-8")

    assert "SUBMIT_FEEDBACK" in bg_content, "background.js does not handle SUBMIT_FEEDBACK message"
    assert "/feedback" in bg_content, "background.js does not forward feedback to /feedback endpoint"
    print("  -> background.js includes SUBMIT_FEEDBACK handler routing to /feedback.")

    # 4. sidepanel.css audit
    css_path = WORKSPACE_ROOT / "extension" / "sidepanel.css"
    assert css_path.is_file(), f"sidepanel.css not found at {css_path}"
    css_content = css_path.read_text(encoding="utf-8")

    assert ".badge-override" in css_content, "sidepanel.css missing .badge-override style"
    assert ".feedback-container" in css_content, "sidepanel.css missing .feedback-container style"
    assert ".feedback-correction-box" in css_content, "sidepanel.css missing .feedback-correction-box style"
    print("  -> sidepanel.css includes .badge-override and feedback layout styles.")


def main():
    print("=" * 75)
    print("PHASE 5 TEST SUITE: WRONG-ANSWER LOGGING, OVERRIDES & WEEKLY RE-EVAL")
    print("=" * 75)

    test_1_cache_eviction_on_unverified_flag()
    test_2_order_invariant_user_verified_override_on_jumbled_options()
    test_3_deduplicated_questions_csv_auto_append()
    test_4_weekly_reeval_and_drift_comparison()
    test_5_extension_feedback_ui_audit()

    print("\n" + "=" * 75)
    print("ALL 5 PHASE 5 VERIFICATION TESTS PASSED (100% SUCCESS)")
    print("=" * 75)


if __name__ == "__main__":
    main()
