"""Phase 1 Verification Suite for QuizZy FastAPI backend and order-invariant cache."""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import httpx
from fastapi.testclient import TestClient

from backend.app import app
from backend.cache import (
    cache_solution,
    clear_cache,
    compute_cache_key,
    get_cache_stats,
    get_cached_solution,
    init_db,
)
from backend.core.llm_client import SolverResponse
from eval.run_eval import run_self_test


def test_offline_cache_unit():
    """Unit tests for order-invariant cache and dynamic remapping."""
    print("\n[Cache Unit Test] Testing order-invariant key generation & dynamic remapping...")

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmpdir:
        test_db = os.path.join(tmpdir, "test_cache.db")
        init_db(test_db)

        # 1. Order Invariance of Cache Keys
        opts_a = ["Alpha", "Beta", "Gamma", "Delta"]
        opts_b = ["Delta", "Alpha", "Beta", "Gamma"]
        key_a = compute_cache_key("Subject", "mcq", "Question text?", opts_a)
        key_b = compute_cache_key("Subject", "mcq", "Question text?", opts_b)
        assert key_a == key_b, f"Cache keys must be order-invariant! {key_a} != {key_b}"
        print("  -> Passed order-invariant key hashing.")

        # 2. MCQ Dynamic Index Remapping
        # Cache winning option 'Gamma' when options were in order [Alpha, Beta, Gamma, Delta]
        fake_mcq_sol = SolverResponse(
            status="OK",
            confidence_tier="HIGH_BOTH_AGREE",
            canonical_key="C",
            selected_index=2,
            selected_text="Gamma",
            reason="Gamma is correct",
            latency_ms=650.0,
        )
        cached_ok = cache_solution("Subject", "mcq", "Question text?", opts_a, fake_mcq_sol, db_path=test_db)
        assert cached_ok is True

        # Now lookup with jumbled options: [Gamma, Delta, Alpha, Beta]
        jumbled_opts = ["Gamma", "Delta", "Alpha", "Beta"]
        hit = get_cached_solution("Subject", "mcq", "Question text?", jumbled_opts, db_path=test_db)
        assert hit is not None, "Expected cache hit!"
        assert hit["answer"] == "A", f"Expected remapped answer 'A', got '{hit['answer']}'"
        assert hit["selected_index"] == 0, f"Expected remapped index 0, got {hit['selected_index']}"
        assert hit["selected_text"] == "Gamma"
        assert hit["cache_hit"] is True
        print("  -> Passed MCQ dynamic index remapping on jumbled options.")

        # 3. Order Dynamic Index Remapping
        # Target sequence: [Step 1, Step 2, Step 3, Step 4]
        order_opts = ["Step 1", "Step 2", "Step 3", "Step 4"]
        target_ordered_texts = ["Step 1", "Step 2", "Step 3", "Step 4"]
        fake_order_sol = SolverResponse(
            status="OK",
            confidence_tier="HIGH_BOTH_AGREE",
            canonical_key="A,B,C,D",
            permutation_indices=[0, 1, 2, 3],
            ordered_texts=target_ordered_texts,
            reason="Logical chronological progression",
            latency_ms=720.0,
        )
        cache_solution("History", "order", "Chronological order?", order_opts, fake_order_sol, db_path=test_db)

        # Lookup with jumbled options: [Step 3, Step 1, Step 4, Step 2]
        # In current options:
        # Step 1 is at index 1 ('B')
        # Step 2 is at index 3 ('D')
        # Step 3 is at index 0 ('A')
        # Step 4 is at index 2 ('C')
        # Expected sequence of synthetic letters: B,D,A,C -> permutation_indices: [1, 3, 0, 2]
        jumbled_order_opts = ["Step 3", "Step 1", "Step 4", "Step 2"]
        order_hit = get_cached_solution("History", "order", "Chronological order?", jumbled_order_opts, db_path=test_db)
        assert order_hit is not None, "Expected order cache hit!"
        assert order_hit["permutation_indices"] == [1, 3, 0, 2], f"Got {order_hit['permutation_indices']}"
        assert order_hit["answer"] == "B,D,A,C", f"Got {order_hit['answer']}"
        assert order_hit["ordered_texts"] == target_ordered_texts
        print("  -> Passed Order dynamic index remapping on jumbled options.")

        # 4. Zero-Poison Rule
        fake_uncertain = SolverResponse(
            status="UNCERTAIN",
            confidence_tier="UNCERTAIN_PRIMARY_FAILURE",
            latency_ms=3000.0,
        )
        assert cache_solution("Math", "text", "1+1?", [], fake_uncertain, db_path=test_db) is False

        fake_low = SolverResponse(
            status="OK",
            confidence_tier="LOW_FALLBACK_RESCUE",
            canonical_key="2",
            selected_text="2",
            latency_ms=1800.0,
        )
        assert cache_solution("Math", "text", "1+1?", [], fake_low, db_path=test_db) is False

        stats = get_cache_stats(db_path=test_db)
        # Only 2 entries should be cached (mcq and order from above)
        assert stats["cache_entries"] == 2, f"Expected 2 cached entries, got {stats['cache_entries']}"
        print("  -> Passed Zero-Poison rule: uncertain and low confidence solutions are rejected.")


def test_api_endpoints_offline():
    """Test API endpoints offline with TestClient."""
    print("\n[API Test] Testing FastAPI endpoints (/health, /stats, validation)...")

    with TestClient(app) as client:
        # 1. Health endpoint
        r_health = client.get("/health")
        assert r_health.status_code == 200
        health_data = r_health.json()
        assert health_data["status"] == "ok"
        assert "models" in health_data
        print("  -> Passed GET /health.")

        # 2. Stats endpoint
        r_stats = client.get("/stats")
        assert r_stats.status_code == 200
        stats_data = r_stats.json()
        assert stats_data["status"] == "ok"
        assert "total_hits" in stats_data
        assert "total_misses" in stats_data
        print("  -> Passed GET /stats.")

        # 3. Input Validation
        # Blank question
        r_blank = client.post("/solve", json={"q_type": "mcq", "question": "   ", "options": ["A", "B"]})
        assert r_blank.status_code == 422, f"Expected 422 for blank question, got {r_blank.status_code}"

        # MCQ with only 1 option
        r_one_opt = client.post("/solve", json={"q_type": "mcq", "question": "Valid?", "options": ["Only one"]})
        assert r_one_opt.status_code == 422

        # Order with 0 options
        r_no_opts = client.post("/solve", json={"q_type": "order", "question": "Order?", "options": []})
        assert r_no_opts.status_code == 422
        print("  -> Passed all 422 input validation constraints.")


def test_live_api_solve():
    """Test live POST /solve end-to-end including jumbled cache hit."""
    print("\n[Live Solve Test] Testing live POST /solve and jumbled cache hits...")

    with TestClient(app) as client:
        # Question 1: MCQ Biology
        mcq_payload = {
            "subject": "Biology",
            "q_type": "mcq",
            "question": "What is the primary powerhouse of the eukaryotic cell?",
            "options": ["Ribosome", "Mitochondrion", "Nucleus", "Endoplasmic reticulum"],
            "bypass_cache": True,  # Force live completion first
        }

        r1 = client.post("/solve", json=mcq_payload)
        assert r1.status_code == 200, f"Live call failed: {r1.text}"
        res1 = r1.json()
        assert res1["status"] == "ok"
        assert res1["answer"] == "B"
        assert res1["selected_index"] == 1
        assert res1["selected_text"] == "Mitochondrion"
        assert res1["confidence_label"] == "high"
        assert res1["auto_eligible"] is True
        assert res1["cache_hit"] is False
        print(f"  -> Live MCQ Call: {res1['answer']} ({res1['selected_text']}) in {res1['latency_ms']}ms [OK]")

        # Question 1 with JUMBLED options: cache hit should return new index!
        jumbled_options = ["Endoplasmic reticulum", "Nucleus", "Mitochondrion", "Ribosome"]
        r2 = client.post("/solve", json={
            "subject": "Biology",
            "q_type": "mcq",
            "question": "What is the primary powerhouse of the eukaryotic cell?",
            "options": jumbled_options,
            "bypass_cache": False,
        })
        assert r2.status_code == 200
        res2 = r2.json()
        assert res2["cache_hit"] is True, "Expected cache hit on jumbled options!"
        assert res2["answer"] == "C", f"Expected remapped letter 'C', got '{res2['answer']}'"
        assert res2["selected_index"] == 2
        assert res2["selected_text"] == "Mitochondrion"
        print(f"  -> Jumbled Cache Hit: dynamically remapped to '{res2['answer']}' (index {res2['selected_index']}) in {res2['latency_ms']}ms [OK]")

        # Question 2: Free Text Chemistry
        text_payload = {
            "subject": "Chemistry",
            "q_type": "text",
            "question": "What is the chemical symbol for gold?",
            "options": [],
        }
        r3 = client.post("/solve", json=text_payload)
        assert r3.status_code == 200
        res3 = r3.json()
        assert res3["status"] == "ok"
        assert "au" in res3["answer"].lower() or "gold" in res3["answer"].lower()
        print(f"  -> Live Free-Text Call: '{res3['answer']}' in {res3['latency_ms']}ms [OK]")

        # Question 3: Live Order with Jumbled Cache Remapping
        order_payload = {
            "subject": "Software Engineering",
            "q_type": "order",
            "question": "Arrange the standard stages of the Software Development Life Cycle (SDLC) in chronological order.",
            "options": ["Deployment", "Requirements Analysis", "System Design", "Coding & Implementation"],
            "bypass_cache": True,
        }
        r4 = client.post("/solve", json=order_payload)
        assert r4.status_code == 200
        res4 = r4.json()
        assert res4["status"] == "ok"
        assert res4["answer"] == "B,C,D,A"
        assert res4["permutation_indices"] == [1, 2, 3, 0]
        print(f"  -> Live Order Call: '{res4['answer']}' in {res4['latency_ms']}ms [OK]")

        # Order with jumbled options -> cache hit
        jumbled_order = ["Coding & Implementation", "Deployment", "Requirements Analysis", "System Design"]
        r5 = client.post("/solve", json={
            "subject": "Software Engineering",
            "q_type": "order",
            "question": "Arrange the standard stages of the Software Development Life Cycle (SDLC) in chronological order.",
            "options": jumbled_order,
            "bypass_cache": False,
        })
        assert r5.status_code == 200
        res5 = r5.json()
        assert res5["cache_hit"] is True
        assert res5["answer"] == "C,D,A,B"
        assert res5["permutation_indices"] == [2, 3, 0, 1]
        print(f"  -> Jumbled Order Cache Hit: dynamically remapped to '{res5['answer']}' (indices {res5['permutation_indices']}) in {res5['latency_ms']}ms [OK]")


def main():
    print("=" * 70)
    print("RUNNING PHASE 1 VERIFICATION TEST SUITE")
    print("=" * 70)

    # 1. Regression check on Phase 0 self-test
    print("\n[Regression Check] Running Phase 0 evaluation self-tests...")
    self_test_passed = run_self_test()
    assert self_test_passed, "Phase 0 self-tests must pass without regression!"
    print("  -> Phase 0 self-test regression check PASSED.")

    # 2. Offline Cache Unit Tests
    test_offline_cache_unit()

    # 3. Offline API Endpoint Validation
    test_api_endpoints_offline()

    # 4. Live API End-to-End Solve
    test_live_api_solve()

    print("\n" + "=" * 70)
    print("ALL PHASE 1 VERIFICATION TESTS PASSED (100% SUCCESS)")
    print("=" * 70)


if __name__ == "__main__":
    main()
