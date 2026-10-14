"""Phase 2 Verification Suite for QuizZy Chrome MV3 Extension, Zero-DOM-Mutation, and Multi-Format Solving."""

from __future__ import annotations

import json
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from fastapi.testclient import TestClient
from backend.app import app
from backend.core.normalizer import SYNTHETIC_LABELS, normalize_mcq_answer, normalize_order_answer


def test_manifest_compliance():
    """Test 1: Chrome Manifest V3 Audit."""
    print("\n[Test 1] Auditing extension/manifest.json compliance...")
    manifest_path = PROJECT_ROOT / "extension" / "manifest.json"
    assert manifest_path.exists(), f"manifest.json missing at {manifest_path}"

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    # 1. Manifest version
    assert manifest.get("manifest_version") == 3, f"Expected manifest_version 3, got {manifest.get('manifest_version')}"
    print("  -> Passed manifest_version == 3")

    # 2. Permissions
    permissions = manifest.get("permissions", [])
    for perm in ["sidePanel", "activeTab", "scripting", "storage"]:
        assert perm in permissions, f"Missing required permission '{perm}' in manifest.json"
    print(f"  -> Passed permissions audit: {permissions}")

    # 3. Host permissions
    host_permissions = manifest.get("host_permissions", [])
    assert any("127.0.0.1:8000" in hp for hp in host_permissions), "Missing 127.0.0.1:8000 in host_permissions"
    print(f"  -> Passed host_permissions audit: {host_permissions}")

    # 4. Strict absence of intrusive capabilities
    assert "web_accessible_resources" not in manifest, "STRICT VIOLATION: web_accessible_resources must NOT be declared!"
    assert "content_scripts" not in manifest, "STRICT VIOLATION: persistent content_scripts must NOT be declared!"
    print("  -> Passed strict exclusion: zero web_accessible_resources, zero persistent content_scripts")

    # 5. Side panel & background configuration
    side_panel = manifest.get("side_panel", {})
    assert side_panel.get("default_path") == "sidepanel.html", f"Expected default_path 'sidepanel.html', got {side_panel}"

    background = manifest.get("background", {})
    assert background.get("service_worker") == "background.js", f"Expected service_worker 'background.js', got {background}"
    print("  -> Passed side_panel and background service worker wiring")


def test_zero_dom_mutation_code_audit():
    """Test 2: Static Code Audit for Zero-DOM-Mutation in Extractor & Side Panel."""
    print("\n[Test 2] Auditing Zero-DOM-Mutation implementation...")

    extractor_path = PROJECT_ROOT / "extension" / "extractor.js"
    assert extractor_path.exists(), f"extractor.js missing at {extractor_path}"

    with open(extractor_path, "r", encoding="utf-8") as f:
        extractor_code = f.read()

    # Extract the extractQuizFromDom function body
    match = re.search(
        r"function\s+extractQuizFromDom\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*(?:/\*\*|function\s+applyDomHighlight)",
        extractor_code
    )
    assert match, "Could not isolate extractQuizFromDom function in extractor.js"
    func_body = match.group(1)

    # List of DOM mutation methods that MUST NOT appear inside extractQuizFromDom
    forbidden_mutation_patterns = [
        r"\.style\s*=",
        r"\.style\[",
        r"\.style\.\w+\s*=",
        r"\.classList\.add\b",
        r"\.classList\.remove\b",
        r"\.classList\.toggle\b",
        r"\.setAttribute\b",
        r"\.removeAttribute\b",
        r"\.appendChild\b",
        r"\.insertBefore\b",
        r"\.removeChild\b",
        r"\.innerHTML\s*=",
        r"\.outerHTML\s*=",
        r"\.innerText\s*=",
        r"\.textContent\s*="
    ]

    for pat in forbidden_mutation_patterns:
        found = re.findall(pat, func_body)
        assert not found, f"STRICT VIOLATION: Mutation pattern '{pat}' found in extractQuizFromDom: {found}"

    print("  -> Passed static audit: extractQuizFromDom performs ZERO DOM mutations.")

    # Audit sidepanel.js for default highlight behavior
    sidepanel_js_path = PROJECT_ROOT / "extension" / "sidepanel.js"
    with open(sidepanel_js_path, "r", encoding="utf-8") as f:
        sp_code = f.read()

    # Verify toggle default in storage loading
    assert "domHighlightEnabled: false" in sp_code or "toggleDomHighlight.checked = false" in sp_code, (
        "domHighlightEnabled must default to false in sidepanel.js"
    )
    # Verify apply highlight is conditional on toggle
    assert "if (toggleDomHighlight.checked" in sp_code, (
        "APPLY_HIGHLIGHT must be guarded by toggleDomHighlight.checked"
    )
    print("  -> Passed sidepanel.js default zero-mutation setting audit.")

    # Audit sidepanel.html for unchecked default
    sidepanel_html_path = PROJECT_ROOT / "extension" / "sidepanel.html"
    with open(sidepanel_html_path, "r", encoding="utf-8") as f:
        sp_html = f.read()

    assert '<input type="checkbox" id="toggle-dom-highlight" />' in sp_html or (
        'id="toggle-dom-highlight"' in sp_html and "checked" not in sp_html.split('id="toggle-dom-highlight"')[0].split("<input")[-1]
    ), "toggle-dom-highlight must be unchecked by default in sidepanel.html"
    print("  -> Passed sidepanel.html unchecked default checkbox audit.")


import time


def post_solve_with_retry(client: TestClient, payload: dict, max_retries: int = 3):
    """Post /solve with retry if transient external LLM budget/network jitter occurs."""
    for attempt in range(max_retries + 1):
        res = client.post("/solve", json=payload)
        data = res.json()
        if data.get("status") == "ok" or attempt == max_retries:
            return res, data
        time.sleep(1.0)
    return res, data


def test_backend_multi_option_and_true_false():
    """Test 3: Backend 2-to-6 option and True/False support."""
    print("\n[Test 3] Testing backend 2-to-6 option and True/False solve endpoints...")

    assert SYNTHETIC_LABELS == ("A", "B", "C", "D", "E", "F"), f"Expected 6 synthetic labels, got {SYNTHETIC_LABELS}"
    print(f"  -> Passed SYNTHETIC_LABELS definition: {SYNTHETIC_LABELS}")

    with TestClient(app) as client:
        # Test 3a: 2-Option True/False MCQ
        tf_payload = {
            "subject": "Genetics",
            "q_type": "mcq",
            "question": "DNA replication is semiconservative.",
            "options": ["True", "False"],
            "bypass_cache": True,
        }
        res_tf, data_tf = post_solve_with_retry(client, tf_payload)
        assert res_tf.status_code == 200, f"True/False failed: {res_tf.text}"
        assert data_tf["status"] == "ok"
        assert data_tf["selected_index"] == 0, f"Expected 'True' (index 0), got index {data_tf['selected_index']}"
        assert data_tf["selected_text"] == "True"
        assert data_tf["answer"] == "A"
        print(f"  -> Passed 2-Option True/False solve: '{data_tf['selected_text']}' in {data_tf['latency_ms']}ms [OK]")

        # Test 3b: Standard 4-Option MCQ
        mcq_payload = {
            "subject": "Cellular Biology",
            "q_type": "mcq",
            "question": "What organelle produces ATP through cellular respiration?",
            "options": ["Ribosome", "Mitochondrion", "Endoplasmic reticulum", "Golgi apparatus"],
            "bypass_cache": True,
        }
        res_mcq, data_mcq = post_solve_with_retry(client, mcq_payload)
        assert res_mcq.status_code == 200, f"MCQ failed: {res_mcq.text}"
        assert data_mcq["status"] == "ok"
        assert data_mcq["selected_index"] == 1
        assert data_mcq["selected_text"] == "Mitochondrion"
        assert data_mcq["answer"] == "B"
        print(f"  -> Passed 4-Option MCQ solve: '{data_mcq['selected_text']}' in {data_mcq['latency_ms']}ms [OK]")

        # Test 3c: 4-Block Unlabelled Order
        order_payload = {
            "subject": "Cytology",
            "q_type": "order",
            "question": "Arrange the four stages of mitosis in correct sequential order from first to last: Prophase, Metaphase, Anaphase, Telophase",
            "options": ["Anaphase", "Prophase", "Telophase", "Metaphase"],
            "bypass_cache": True,
        }
        res_order, data_order = post_solve_with_retry(client, order_payload)
        assert res_order.status_code == 200, f"Order failed: {res_order.text}"
        assert data_order["status"] == "ok"
        assert sorted(data_order["permutation_indices"]) == [0, 1, 2, 3], f"Invalid permutation: {data_order['permutation_indices']}"
        assert data_order["ordered_texts"][0] == "Prophase"
        assert data_order["ordered_texts"][-1] == "Telophase"
        print(f"  -> Passed 4-Block Order solve: '{data_order['answer']}' in {data_order['latency_ms']}ms [OK]")

        # Test 3d: Free-Text Input
        text_payload = {
            "subject": "Inorganic Chemistry",
            "q_type": "text",
            "question": "What is the chemical symbol for the element Gold?",
            "options": [],
            "bypass_cache": True,
        }
        res_text, data_text = post_solve_with_retry(client, text_payload)
        assert res_text.status_code == 200, f"Text failed: {res_text.text}"
        assert data_text["status"] == "ok"
        assert "au" in data_text["answer"].lower() or "gold" in data_text["answer"].lower()
        print(f"  -> Passed Free-Text solve: '{data_text['answer']}' in {data_text['latency_ms']}ms [OK]")

        # Test 3e: Boundary Option Count Validation
        # 1 option -> 422
        r_too_few = client.post("/solve", json={"q_type": "mcq", "question": "Valid?", "options": ["Only one"]})
        assert r_too_few.status_code == 422, f"Expected 422 for 1 option, got {r_too_few.status_code}"

        # 7 options -> 422
        r_too_many = client.post("/solve", json={"q_type": "mcq", "question": "Valid?", "options": ["A", "B", "C", "D", "E", "F", "G"]})
        assert r_too_many.status_code == 422, f"Expected 422 for 7 options, got {r_too_many.status_code}"
        print("  -> Passed 2-to-6 option boundary constraints (1 option -> 422, 7 options -> 422).")


class SimpleNode:
    """Lightweight node representation for testing DOM extraction against HTML."""
    def __init__(self, tag, attrs=None):
        self.tag = tag
        self.attrs = dict(attrs) if attrs else {}
        self.children = []
        self.text_content = ""

    def get_text(self):
        txt = self.text_content
        for child in self.children:
            txt += " " + child.get_text()
        return " ".join(txt.split())


class MiniDOMParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root = SimpleNode("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = SimpleNode(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in ("meta", "link", "input", "br", "hr", "img"):
            self.stack.append(node)

    def handle_endtag(self, tag):
        if len(self.stack) > 1 and self.stack[-1].tag == tag:
            self.stack.pop()

    def handle_data(self, data):
        if self.stack:
            self.stack[-1].text_content += data


def find_nodes(node, predicate):
    results = []
    if predicate(node):
        results.append(node)
    for child in node.children:
        results.extend(find_nodes(child, predicate))
    return results


def test_mock_quiz_html_integrity():
    """Test 4: Mock Quiz HTML Integrity & Extraction Simulation."""
    print("\n[Test 4] Testing tests/mock_quiz.html integrity and extraction logic...")

    html_path = PROJECT_ROOT / "tests" / "mock_quiz.html"
    assert html_path.exists(), f"mock_quiz.html missing at {html_path}"

    with open(html_path, "r", encoding="utf-8") as f:
        html_content = f.read()

    # 1. Check tripwire banner and script presence
    assert "tripwire-banner" in html_content
    assert "MutationObserver" in html_content
    assert "QuizZyMutationTripwire" in html_content
    assert "DOM Integrity: CLEAN (0 unauthorized mutations)" in html_content
    print("  -> Passed live MutationObserver tripwire monitor integrity check.")

    # 2. Check 4 scenarios presence
    for scenario_id in ["scenario-mcq4", "scenario-mcq2", "scenario-order4", "scenario-text"]:
        assert scenario_id in html_content, f"Missing scenario '{scenario_id}' in mock_quiz.html"
    print("  -> Passed all 4 quiz scenario sections presence check.")

    # 3. Simulate Extractor DOM logic against mock_quiz.html
    parser = MiniDOMParser()
    parser.feed(html_content)
    root = parser.root

    # Scenario 1 (MCQ 4 options)
    sc1 = find_nodes(root, lambda n: n.attrs.get("id") == "scenario-mcq4")[0]
    subject1 = find_nodes(sc1, lambda n: "data-quiz-subject" in n.attrs)[0].get_text()
    question1 = find_nodes(sc1, lambda n: "data-quiz-question" in n.attrs)[0].get_text()
    options1 = [n.get_text() for n in find_nodes(sc1, lambda n: "data-quiz-option" in n.attrs)]
    assert subject1 == "Cellular Biology"
    assert "ATP through cellular respiration" in question1
    assert len(options1) == 4
    assert "Mitochondrion" in options1
    print(f"  -> Simulated Scenario 1 Extraction: '{subject1}', {len(options1)} options [PASS]")

    # Scenario 2 (MCQ 2 options True/False)
    sc2 = find_nodes(root, lambda n: n.attrs.get("id") == "scenario-mcq2")[0]
    subject2 = find_nodes(sc2, lambda n: "data-quiz-subject" in n.attrs)[0].get_text()
    question2 = find_nodes(sc2, lambda n: "data-quiz-question" in n.attrs)[0].get_text()
    options2 = [n.get_text() for n in find_nodes(sc2, lambda n: "data-quiz-option" in n.attrs)]
    assert subject2 == "Genetics"
    assert "semiconservative" in question2
    assert options2 == ["True", "False"]
    print(f"  -> Simulated Scenario 2 Extraction: '{subject2}', options={options2} [PASS]")

    # Scenario 3 (Order 4 draggable items)
    sc3 = find_nodes(root, lambda n: n.attrs.get("id") == "scenario-order4")[0]
    subject3 = find_nodes(sc3, lambda n: "data-quiz-subject" in n.attrs)[0].get_text()
    question3 = find_nodes(sc3, lambda n: "data-quiz-question" in n.attrs)[0].get_text()
    options3 = [n.get_text().replace("☰", "").strip() for n in find_nodes(sc3, lambda n: "data-quiz-option" in n.attrs)]
    assert subject3 == "Cytology"
    assert "Arrange the four stages" in question3
    assert len(options3) == 4
    assert "Prophase" in options3
    print(f"  -> Simulated Scenario 3 Extraction: '{subject3}', {len(options3)} draggable blocks [PASS]")

    # Scenario 4 (Text input)
    sc4 = find_nodes(root, lambda n: n.attrs.get("id") == "scenario-text")[0]
    subject4 = find_nodes(sc4, lambda n: "data-quiz-subject" in n.attrs)[0].get_text()
    question4 = find_nodes(sc4, lambda n: "data-quiz-question" in n.attrs)[0].get_text()
    inputs4 = find_nodes(sc4, lambda n: "data-quiz-input" in n.attrs)
    assert subject4 == "Inorganic Chemistry"
    assert "chemical symbol for the element Gold" in question4
    assert len(inputs4) == 1
    print(f"  -> Simulated Scenario 4 Extraction: '{subject4}', 1 free-text input [PASS]")


def main():
    print("=" * 70)
    print("RUNNING PHASE 2 EXTENSION & ZERO-DOM-MUTATION VERIFICATION SUITE")
    print("=" * 70)

    test_manifest_compliance()
    test_zero_dom_mutation_code_audit()
    test_backend_multi_option_and_true_false()
    test_mock_quiz_html_integrity()

    print("\n" + "=" * 70)
    print("ALL PHASE 2 VERIFICATION TESTS PASSED (100% SUCCESS)")
    print("=" * 70)


if __name__ == "__main__":
    main()
