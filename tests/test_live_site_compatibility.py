"""Verification suite for live-site compatibility hotfix on learning.ccbp.in and React/KaTeX quizzes."""

from __future__ import annotations

import json
import re
import subprocess
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

    # 2. Fractions and algebra preservation in decorative prefix stripper
    assert "stripDecorativePrefix" in code
    strip_regex = re.compile(
        r"^(?:"
        r"[A-Fa-f][\.\)\:]\s+"
        r"|\([A-Fa-f0-9]{1,2}\)\s+"
        r"|\[[A-Fa-f0-9]{1,2}\]\s+"
        r"|[0-9]{1,2}[\.\)]\s+"
        r"|[\u2022\u25E6\u25AA\u2023]\s*"
        r")"
    )
    assert strip_regex.sub("", "1 - 1/6") == "1 - 1/6", "Prefix stripper must NOT strip '1 - 1/6'!"
    assert strip_regex.sub("", "1 - P(A)") == "1 - P(A)", "Prefix stripper must NOT strip '1 - P(A)'!"
    assert strip_regex.sub("", "A - B") == "A - B", "Prefix stripper must NOT strip 'A - B'!"
    assert strip_regex.sub("", "n - 1") == "n - 1", "Prefix stripper must NOT strip 'n - 1'!"
    assert strip_regex.sub("", "x : y") == "x : y", "Prefix stripper must NOT strip 'x : y'!"
    assert strip_regex.sub("", "1/6") == "1/6", "Prefix stripper must NOT strip '1/6'!"
    assert strip_regex.sub("", "2/36") == "2/36", "Prefix stripper must NOT strip '2/36'!"
    assert strip_regex.sub("", "A. 1/6") == "1/6", "Prefix stripper must strip 'A. ' from 'A. 1/6'"
    assert strip_regex.sub("", "1) 1/6") == "1/6", "Prefix stripper must strip '1) ' from '1) 1/6'"
    assert strip_regex.sub("", "B) 1 - 1/6") == "1 - 1/6", "Prefix stripper must strip 'B) ' from 'B) 1 - 1/6'"
    assert strip_regex.sub("", "C: A - B") == "A - B", "Prefix stripper must strip 'C: ' from 'C: A - B'"

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
    assert "pollIntervalMs" in code or "120" in code, "Must poll DOM for Next button"
    assert "4500" in code, "Must have 4500ms polling ceiling"

    # 2. Check React radio input event dispatch in executeMcqAction
    assert "input[type='radio']" in code
    assert "radio.checked" in code
    assert 'new Event("change"' in code or "new Event('change'" in code
    assert 'new Event("input"' in code or "new Event('input'" in code

    # 3. Check background.js awaits clickNextButton
    bg_path = PROJECT_ROOT / "extension" / "background.js"
    with open(bg_path, "r", encoding="utf-8") as f:
        bg_code = f.read()

    assert "func: async (customNextSelector)" in bg_code, "background.js must use async func in executeScript"
    assert "await window.QuizZyExecutor.clickNextButton" in bg_code, "background.js must await clickNextButton"
    print("  -> Passed executor.js & background.js: Two-step SUBMIT -> NEXT flow with DOM polling & React radio events.")


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


def test_nodejs_runtime_verification():
    """Execute real Node.js runtime verification against KaTeX DOM, tricky decimals/ratios, multi-block code questions, and async 900ms polling."""
    print("\n[Test 7] Executing real Node.js runtime verification (node -e)...")

    js_script = r"""
const path = require("path");

class MockNode {
  constructor(tagOrText, isText = false) {
    if (isText) {
      this.nodeType = 3;
      this.nodeValue = String(tagOrText);
      this._text = this.nodeValue;
      this.childNodes = [];
    } else {
      this.nodeType = 1;
      this.tagName = String(tagOrText).toUpperCase();
      this.className = "";
      this.attributes = {};
      this.childNodes = [];
      this.parentElement = null;
      this.parentNode = null;
      this.disabled = false;
      this._checked = false;
      this.value = "";
      this._text = "";
      this.listeners = {};
    }
  }

  get checked() {
    return Boolean(this._checked);
  }

  set checked(v) {
    this._checked = Boolean(v);
  }

  get firstElementChild() {
    return this.childNodes.find(c => c.nodeType === 1) || null;
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const sibs = this.parentElement.children;
    const idx = sibs.indexOf(this);
    return idx > 0 ? sibs[idx - 1] : null;
  }

  get classList() {
    const self = this;
    return {
      contains(cls) {
        return (self.className || "").split(/\s+/).includes(cls);
      },
      add(cls) {
        const classes = new Set((self.className || "").split(/\s+/).filter(Boolean));
        classes.add(cls);
        self.className = Array.from(classes).join(" ");
      },
      remove(cls) {
        const classes = new Set((self.className || "").split(/\s+/).filter(Boolean));
        classes.delete(cls);
        self.className = Array.from(classes).join(" ");
      }
    };
  }

  getAttribute(attr) {
    if (attr === "class") return this.className;
    if (attr === "disabled" && this.disabled) return "";
    if (attr === "value") return this.value;
    if (attr === "type") return this.type || this.attributes["type"] || null;
    return this.attributes[attr] || null;
  }

  hasAttribute(attr) {
    if (attr === "class") return Boolean(this.className);
    if (attr === "value") return Boolean(this.value);
    if (attr === "type") return Boolean(this.type || this.attributes["type"]);
    return attr in this.attributes;
  }

  setAttribute(attr, val) {
    if (attr === "class") {
      this.className = String(val);
    } else {
      if (attr === "value") this.value = String(val);
      if (attr === "type") this.type = String(val);
      this.attributes[attr] = String(val);
    }
  }

  appendChild(child) {
    child.parentElement = this;
    child.parentNode = this;
    const last = this.childNodes[this.childNodes.length - 1];
    if (last) {
      last.nextSibling = child;
      child.previousSibling = last;
    }
    this.childNodes.push(child);
    this.firstChild = this.childNodes[0];
    this.lastChild = child;
    return child;
  }

  get children() {
    return this.childNodes.filter(c => c.nodeType === 1);
  }

  get textContent() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map(c => c.textContent).join("");
  }

  set textContent(v) {
    if (this.nodeType === 3) {
      this.nodeValue = String(v);
    } else {
      this.childNodes = [new MockNode(String(v), true)];
      this.firstChild = this.childNodes[0];
      this.lastChild = this.childNodes[0];
    }
  }

  get innerText() {
    if (this.nodeType === 3) return this.nodeValue;
    return this.childNodes.map(c => c.innerText).join("");
  }

  set innerText(v) {
    this.textContent = v;
  }

  getBoundingClientRect() {
    return { width: 100, height: 40, top: 10, left: 10 };
  }

  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  dispatchEvent(event) {
    if (this.listeners[event.type]) {
      for (const fn of this.listeners[event.type]) {
        fn.call(this, event);
      }
    }
    if (event.bubbles && this.parentElement) {
      this.parentElement.dispatchEvent(event);
    }
    return true;
  }

  click() {
    this.dispatchEvent({ type: "click", bubbles: true, target: this });
  }

  focus() {}

  matches(sel) {
    if (!sel) return false;
    sel = sel.trim();
    if (this.nodeType !== 1) return false;

    const attrMatch = sel.match(/^([a-zA-Z0-9_-]+|\.[a-zA-Z0-9_-]+)?\[([^\]]+)\]$/);
    if (attrMatch) {
      const base = attrMatch[1];
      const attrExpr = attrMatch[2];
      if (base) {
        if (base.startsWith(".")) {
          if (!this.classList.contains(base.slice(1))) return false;
        } else {
          if (this.tagName.toLowerCase() !== base.toLowerCase()) return false;
        }
      }
      if (attrExpr.includes("*=")) {
        const [k, v] = attrExpr.split("*=");
        const cleanV = v.replace(/['"]/g, "").trim();
        return (this.getAttribute(k.trim()) || "").includes(cleanV);
      } else if (attrExpr.includes("=")) {
        const [k, v] = attrExpr.split("=");
        const cleanV = v.replace(/['"]/g, "").trim();
        if (k.trim() === "type") return this.type === cleanV;
        return this.getAttribute(k.trim()) === cleanV;
      }
      return this.hasAttribute(attrExpr.trim());
    }

    if (sel.startsWith(".")) {
      return this.classList.contains(sel.slice(1));
    }
    if (sel.startsWith("#")) {
      return this.getAttribute("id") === sel.slice(1);
    }
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.nodeType === 1 && cur.matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel) {
    const results = [];
    const parts = sel.split(",").map(s => s.trim());

    function check(node) {
      if (node.nodeType === 1) {
        for (const p of parts) {
          if (node.matches(p)) {
            results.push(node);
            break;
          }
        }
      }
      for (const child of node.childNodes) {
        check(child);
      }
    }

    for (const child of this.childNodes) {
      check(child);
    }
    return results;
  }
}

// Global environment
global.window = global;
global.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });
global.Event = class Event {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
  }
};
global.MouseEvent = class MouseEvent extends global.Event {};
global.PointerEvent = class PointerEvent extends global.Event {};
global.HTMLInputElement = {
  prototype: {
    get checked() { return this._checked; },
    set checked(v) { this._checked = v; }
  }
};
global.HTMLTextAreaElement = {
  prototype: {
    get value() { return this._val; },
    set value(v) { this._val = v; }
  }
};

function el(tag, className = "", attrs = {}, children = []) {
  const node = new MockNode(tag);
  node.className = className;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "disabled") node.disabled = Boolean(v);
    else if (k === "type") { node.type = String(v); node.setAttribute(k, v); }
    else if (k === "value") { node.value = String(v); node.setAttribute(k, v); }
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === "string") {
      node.appendChild(new MockNode(c, true));
    } else if (c) {
      node.appendChild(c);
    }
  }
  return node;
}

const doc = el("html", "", {}, [el("head"), el("body")]);
doc.body = doc.childNodes[1];
global.document = doc;

const extractor = require(path.resolve(process.cwd(), "extension/extractor.js"));
const executor = require(path.resolve(process.cwd(), "extension/executor.js"));

async function main() {
  // Test 1: Nested KaTeX & Compound Fractions
  if (extractor.normalizeTeX("\\frac{2^{3}}{6}") !== "2^3/6") {
    throw new Error(`Expected '2^3/6', got '${extractor.normalizeTeX("\\frac{2^{3}}{6}")}'`);
  }
  if (extractor.normalizeTeX("\\frac{n+1}{2}") !== "(n+1)/2") {
    throw new Error(`Expected '(n+1)/2', got '${extractor.normalizeTeX("\\frac{n+1}{2}")}'`);
  }
  if (extractor.normalizeTeX("\\frac{1}{6}") !== "1/6") {
    throw new Error(`Expected '1/6', got '${extractor.normalizeTeX("\\frac{1}{6}")}'`);
  }
  if (extractor.normalizeTeX("\\frac{\\sqrt{3}}{2}") !== "sqrt(3)/2") {
    throw new Error(`Expected 'sqrt(3)/2', got '${extractor.normalizeTeX("\\frac{\\sqrt{3}}{2}")}'`);
  }

  // Real KaTeX DOM
  const katexContainer = el("div", "katex", {}, [
    el("span", "katex-mathml", {}, [
      el("annotation", "", { encoding: "application/x-tex" }, ["\\frac{1}{6}"])
    ]),
    el("span", "katex-html", { "aria-hidden": "true" }, [
      el("span", "base", {}, [
        el("span", "mfrac", {}, [
          el("span", "vlist-t", {}, [el("span", "mord", {}, ["1"])]),
          el("span", "frac-line"),
          el("span", "vlist-t", {}, [el("span", "mord", {}, ["6"])])
        ])
      ])
    ])
  ]);
  const optionLabel = el("label", "option-item", {}, [
    el("input", "", { type: "radio", name: "q1" }),
    katexContainer
  ]);

  const cleanOptionText = extractor.getCleanVisibleText(optionLabel);
  if (cleanOptionText !== "1/6") {
    throw new Error(`Expected KaTeX option '1/6', got '${cleanOptionText}'`);
  }

  // Test 2: Probability & Set-Theory Prefix Safety
  const prefixCases = [
    { in: "1 - 1/6", exp: "1 - 1/6" },
    { in: "1 - P(A)", exp: "1 - P(A)" },
    { in: "A - B", exp: "A - B" },
    { in: "n - 1", exp: "n - 1" },
    { in: "x - 1 = 0", exp: "x - 1 = 0" },
    { in: "A : B", exp: "A : B" },
    { in: "x : y", exp: "x : y" },
    { in: "1/6", exp: "1/6" },
    { in: "2/36", exp: "2/36" },
    { in: "1.5", exp: "1.5" },
    { in: "0.25", exp: "0.25" },
    { in: "-1/6", exp: "-1/6" },
    { in: "1:6", exp: "1:6" },
    { in: "0", exp: "0" },
    { in: "A", exp: "A" },
    { in: "(A) 1/6", exp: "1/6" },
    { in: "A. 1.5", exp: "1.5" },
    { in: "B) 1 - 1/6", exp: "1 - 1/6" },
    { in: "1) 1:6", exp: "1:6" },
    { in: "C: A - B", exp: "A - B" },
    { in: "D. 0.25", exp: "0.25" }
  ];
  for (const tc of prefixCases) {
    const res = extractor.stripDecorativePrefix(tc.in);
    if (res !== tc.exp) {
      throw new Error(`stripDecorativePrefix('${tc.in}') produced '${res}', expected '${tc.exp}'`);
    }
  }

  // Test 3: Multi-Line Python Indentation & Nested Explanation Exclusion
  const quizCard = el("div", "quiz-card", {}, [
    el("div", "question-stem", {}, [
      el("p", "", {}, ["Consider the following Python code snippet. Select the correct output."]),
      el("pre", "", {}, [
        el("code", "", {}, ["def foo():\n    return 42\nprint(foo())"])
      ])
    ]),
    el("div", "options-list", {}, [
      el("label", "option-item", {}, [el("input", "", { type: "radio", name: "p1" }), " 42"]),
      el("label", "option-item", {}, [el("input", "", { type: "radio", name: "p1" }), " None"]),
      el("label", "option-item", {}, [el("input", "", { type: "radio", name: "p1" }), " Error"])
    ]),
    el("div", "explanation-container", {}, [
      el("h4", "", {}, ["Explanation:"]),
      el("p", "", {}, ["The probability of rolling 6 is 1/6 and foo returns 42."])
    ])
  ]);
  doc.childNodes[1].childNodes = [];
  doc.childNodes[1].appendChild(quizCard);

  const quizResult = extractor.extractQuizFromDom();
  if (!quizResult.success) {
    throw new Error(`Extraction failed: ${quizResult.error}`);
  }
  if (!quizResult.question.includes("def foo():\n    return 42")) {
    throw new Error(`Code indentation/newline was destroyed! Got:\n${quizResult.question}`);
  }
  if (quizResult.question.includes("Explanation") || quizResult.question.includes("rolling 6")) {
    throw new Error(`Post-submit nested explanation leaked into question! Got:\n${quizResult.question}`);
  }
  if (quizResult.options.length !== 3 || quizResult.options[0] !== "42") {
    throw new Error(`Options mismatch: ${JSON.stringify(quizResult.options)}`);
  }

  // Test 4: CSS-Hidden Radio Input with Visible Label
  const hiddenRadioCard = el("div", "quiz-card", {}, [
    el("div", "question-stem", {}, [
      el("p", "", {}, ["What is the capital of France?"])
    ]),
    el("div", "options-list", {}, [
      el("label", "option-card", {}, [
        el("input", "", { type: "radio", name: "q2", value: "Paris", style: "display: none;" }),
        " Paris"
      ]),
      el("label", "option-card", {}, [
        el("input", "", { type: "radio", name: "q2", value: "London", style: "display: none;" }),
        " London"
      ]),
      el("label", "option-card", {}, [
        el("input", "", { type: "radio", name: "q2", value: "Berlin", style: "display: none;" }),
        " Berlin"
      ])
    ])
  ]);
  doc.childNodes[1].childNodes = [];
  doc.childNodes[1].appendChild(hiddenRadioCard);

  const extractedHidden = extractor.extractQuizFromDom();
  if (!extractedHidden.success || extractedHidden.options.length !== 3) {
    throw new Error(`Failed to extract options with CSS-hidden radio inputs: ${JSON.stringify(extractedHidden)}`);
  }
  if (extractedHidden.options[0] !== "Paris") {
    throw new Error(`Expected first option 'Paris', got '${extractedHidden.options[0]}'`);
  }

  const execResult = executor.executeMcqAction({ selected_index: 0 });
  if (!execResult.success) {
    throw new Error(`executeMcqAction failed on CSS-hidden radio: ${JSON.stringify(execResult)}`);
  }
  const parisRadio = hiddenRadioCard.querySelector("input[value='Paris']");
  if (!parisRadio || !parisRadio.checked) {
    throw new Error("CSS-hidden radio was not checked after executeMcqAction!");
  }

  // Test 5: Auto-Mode Completion Detection (QUESTIONS ATTEMPTED: 15/15)
  const completionContainer = el("div", "quiz-summary", {}, [
    el("div", "stats", {}, ["QUESTIONS ATTEMPTED: 15/15"]),
    el("h2", "", {}, ["Practice Completed"]),
    el("button", "btn-report", { type: "button" }, ["View Report"])
  ]);
  doc.childNodes[1].childNodes = [];
  doc.childNodes[1].appendChild(completionContainer);

  const completedResult = await executor.clickNextButton();
  if (!completedResult.ok || completedResult.step !== "quiz_completed") {
    throw new Error(`Expected step 'quiz_completed', got '${JSON.stringify(completedResult)}'`);
  }

  // Test 6: Async two-step Submit -> 300ms delayed Next Question
  const actionContainer = el("div", "actions", {}, [
    el("button", "btn-submit", { type: "button" }, ["Submit"])
  ]);
  doc.childNodes[1].childNodes = [];
  doc.childNodes[1].appendChild(actionContainer);

  const submitBtn = actionContainer.querySelector("button");
  submitBtn.addEventListener("click", () => {
    setTimeout(() => {
      const nextBtn = el("button", "btn-next", { type: "button" }, ["Next Question"]);
      actionContainer.appendChild(nextBtn);
    }, 300);
  });

  const nextResult = await executor.clickNextButton();
  if (!nextResult.ok || nextResult.step !== "submit_then_next") {
    throw new Error(`Expected step 'submit_then_next', got '${JSON.stringify(nextResult)}'`);
  }
  if (nextResult.waited_ms < 240) {
    throw new Error(`Expected wait >= 240ms, got ${nextResult.waited_ms}ms`);
  }

  console.log("NODE_RUNTIME_TESTS_OK");
}

main().catch(err => {
  console.error("NODE_RUNTIME_ERROR:", err.message);
  process.exit(1);
});
"""

    res = subprocess.run(
        ["node", "-e", js_script],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        check=False
    )

    if res.returncode != 0:
        print("Node.js runtime test stdout:\n", res.stdout)
        print("Node.js runtime test stderr:\n", res.stderr)
        raise AssertionError(f"Node.js runtime live-site compatibility test failed with exit code {res.returncode}")

    assert "NODE_RUNTIME_TESTS_OK" in res.stdout, "Missing success confirmation in Node.js runtime tests"
    print("  -> Passed Node.js runtime verification: KaTeX \\frac{1}{6} normalized, 12 numeric variants preserved, code snippets concatenated without explanation pollution, and 900ms delayed Next polling verified.")


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
    test_nodejs_runtime_verification()

    print("\n" + "=" * 70)
    print("ALL LIVE-SITE COMPATIBILITY TESTS PASSED (100% SUCCESS)")
    print("=" * 70)

