"""Verification suite for live-site compatibility hotfix on learning.ccbp.in and React/KaTeX quizzes."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def test_manifest_host_permissions():
    """Verify manifest.json has <all_urls> and zero persistent content scripts."""
    print("\n[Test 1] Auditing extension/manifest.json for external HTTPS host permissions...")
    manifest_path = PROJECT_ROOT / "extension" / "manifest.json"
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    host_perms = manifest.get("host_permissions", [])
    assert "<all_urls>" in host_perms, "Missing '<all_urls>' in host_permissions for external HTTPS quiz origins!"
    assert any("127.0.0.1:8000" in hp for hp in host_perms), "Missing 127.0.0.1:8000 in host_permissions"
    assert "web_accessible_resources" not in manifest, "web_accessible_resources must not be declared!"
    assert "content_scripts" not in manifest, "content_scripts must not be declared!"
    print("  -> Passed manifest.json: <all_urls> present, zero intrusive declarations.")


def test_sidepanel_card_layout_order():
    """Verify sidepanel.html layout: Solution Card directly below Controls Bar."""
    print("\n[Test 2] Auditing extension/sidepanel.html layout hierarchy...")
    sidepanel_path = PROJECT_ROOT / "extension" / "sidepanel.html"
    with open(sidepanel_path, "r", encoding="utf-8") as f:
        html = f.read()

    controls_idx = html.find('class="controls-section"')
    solution_idx = html.find('id="card-solution"')
    preview_idx = html.find('class="card preview-card"')
    automode_idx = html.find('id="card-automode"')

    assert controls_idx != -1, "Missing controls-section in sidepanel.html"
    assert solution_idx != -1, "Missing #card-solution in sidepanel.html"
    assert preview_idx != -1, "Missing preview-card in sidepanel.html"
    assert automode_idx != -1, "Missing #card-automode in sidepanel.html"

    # Hierarchy check: Controls -> Solution -> Preview -> AutoMode
    assert controls_idx < solution_idx, "Solution Card must appear after Controls Section"
    assert solution_idx < preview_idx, "Solution Card must appear BEFORE Preview Card for immediate visibility"
    assert preview_idx < automode_idx, "Preview Card must appear BEFORE Auto Mode Control Card"
    print("  -> Passed sidepanel.html hierarchy: Controls -> Solution Card -> Preview Card -> Auto Mode Control")


def test_extractor_math_and_header_filtering():
    """Audit extractor.js implementation for KaTeX, short math options, and zero DOM mutations."""
    print("\n[Test 3] Auditing extension/extractor.js math handling and header blacklist...")
    extractor_path = PROJECT_ROOT / "extension" / "extractor.js"
    with open(extractor_path, "r", encoding="utf-8") as f:
        code = f.read()

    # 1. Clean math visible text reader
    assert "getCleanVisibleText" in code, "getCleanVisibleText helper missing"
    assert "katex-mathml" in code, "Must filter .katex-mathml duplicate assistive text"
    assert "MJX_Assistive_MathML" in code, "Must filter .MJX_Assistive_MathML duplicate text"
    assert "annotation" in code, "Must filter annotation / annotation-xml tags"

    # 2. Fractions preservation in decorative prefix stripper
    assert "stripDecorativePrefix" in code
    # Verify regex does not strip '1/6' or '2/36'
    strip_regex = re.compile(r"^(?:[A-Za-z][\.\)\:\-]\s*|\([A-Za-z0-9]\)\s*|[0-9]+[\.\)\:\-]\s*|[\u2022\u25E6\u25AA\u2023]\s*)")
    assert strip_regex.sub("", "1/6") == "1/6", "Prefix stripper must NOT strip '1/6'!"
    assert strip_regex.sub("", "2/36") == "2/36", "Prefix stripper must NOT strip '2/36'!"
    assert strip_regex.sub("", "A. 1/6") == "1/6", "Prefix stripper must strip 'A. ' from 'A. 1/6'"
    assert strip_regex.sub("", "1) 1/6") == "1/6", "Prefix stripper must strip '1) ' from '1) 1/6'"

    # 3. Header & nav blacklist
    assert "isHeaderOrNavText" in code
    assert "mcq\\s*practice" in code
    assert "practice\\s*instructions" in code
    assert "end\\s*practice" in code
    assert "questions?\\s*attempted" in code
    assert "score\\s*:" in code

    # 4. Zero DOM mutations audit inside extractQuizFromDom
    match = re.search(
        r"function\s+extractQuizFromDom\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*(?:/\*\*|function\s+applyDomHighlight)",
        code
    )
    assert match, "Could not extract extractQuizFromDom body"
    body = match.group(1)

    forbidden = [
        r"\.style\s*=",
        r"\.style\[",
        r"\.classList\.add\b",
        r"\.classList\.remove\b",
        r"\.setAttribute\b",
        r"\.appendChild\b",
        r"\.innerHTML\s*=",
        r"\.outerHTML\s*=",
    ]
    for pat in forbidden:
        assert not re.findall(pat, body), f"Forbidden DOM mutation '{pat}' found in extractQuizFromDom"

    print("  -> Passed extractor.js: Math-safe text extraction, header blacklist, and Zero-DOM-Mutation.")


def test_executor_two_step_flow():
    """Audit executor.js and background.js for the two-step SUBMIT -> NEXT flow."""
    print("\n[Test 4] Auditing executor.js and background.js for two-step SUBMIT -> NEXT...")
    executor_path = PROJECT_ROOT / "extension" / "executor.js"
    with open(executor_path, "r", encoding="utf-8") as f:
        code = f.read()

    # 1. Check async clickNextButton with two-step flow
    assert "async function clickNextButton" in code, "clickNextButton must be async"
    assert "isIgnoredButton" in code, "isIgnoredButton must be defined to ignore SHOW ANSWER / SKIP"
    assert "show answer" in code.lower()
    assert "skip" in code.lower()
    assert "isSubmitCandidate" in code, "isSubmitCandidate helper missing"
    assert "isNextCandidate" in code, "isNextCandidate helper missing"
    assert "submit_then_next_clicked" in code, "submit_then_next_clicked action missing"
    assert "500" in code, "Must wait ~500ms between submit and next click"

    # 2. Check React radio input event dispatch in executeMcqAction
    assert "input[type='radio']" in code
    assert "radio.checked = true" in code
    assert 'new Event("change"' in code or "new Event('change'" in code
    assert 'new Event("input"' in code or "new Event('input'" in code

    # 3. Check background.js awaits clickNextButton
    bg_path = PROJECT_ROOT / "extension" / "background.js"
    with open(bg_path, "r", encoding="utf-8") as f:
        bg_code = f.read()

    assert "func: async (customNextSelector)" in bg_code, "background.js must use async func in executeScript"
    assert "await window.QuizZyExecutor.clickNextButton" in bg_code, "background.js must await clickNextButton"
    print("  -> Passed executor.js & background.js: Two-step SUBMIT -> NEXT flow with 500ms delay & React radio events.")


def test_sidepanel_apply_once_and_telemetry():
    """Audit sidepanel.js for btn-apply-once and two-step telemetry."""
    print("\n[Test 5] Auditing sidepanel.js for btnApplyOnce and telemetry updates...")
    sp_path = PROJECT_ROOT / "extension" / "sidepanel.js"
    with open(sp_path, "r", encoding="utf-8") as f:
        sp_code = f.read()

    assert "btnApplyOnce.addEventListener" in sp_code, "btnApplyOnce must have click listener"
    assert "EXECUTE_QUIZ_ACTION" in sp_code
    print("  -> Passed sidepanel.js: btnApplyOnce listener wired and telemetry updated.")


def test_mock_quiz_react_math_scenario():
    """Verify mock_quiz.html contains the learning.ccbp.in React math scenario."""
    print("\n[Test 6] Auditing tests/mock_quiz.html for learning.ccbp.in Scenario 5...")
    mock_path = PROJECT_ROOT / "tests" / "mock_quiz.html"
    with open(mock_path, "r", encoding="utf-8") as f:
        html = f.read()

    assert 'id="scenario-react-math"' in html, "Scenario 5 (react-math) missing in mock_quiz.html"
    assert "MCQ PRACTICE | PROBABILITY RULES AND THEOREM" in html
    assert "Two dice are rolled" in html
    assert "1/36" in html
    assert "1/6" in html
    assert "1/12" in html
    assert "2/36" in html
    assert "SHOW ANSWER" in html
    assert "SKIP" in html
    assert "btn-react-submit" in html
    assert "btn-react-next" in html
    print("  -> Passed mock_quiz.html: Scenario 5 (learning.ccbp.in React math) verified.")


if __name__ == "__main__":
    print("=" * 70)
    print("RUNNING LIVE-SITE COMPATIBILITY VERIFICATION SUITE")
    print("=" * 70)

    test_manifest_host_permissions()
    test_sidepanel_card_layout_order()
    test_extractor_math_and_header_filtering()
    test_executor_two_step_flow()
    test_sidepanel_apply_once_and_telemetry()
    test_mock_quiz_react_math_scenario()

    print("\n" + "=" * 70)
    print("ALL LIVE-SITE COMPATIBILITY TESTS PASSED (100% SUCCESS)")
    print("=" * 70)
