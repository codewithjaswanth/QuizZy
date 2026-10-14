# QuizZy ⚡

> **High-speed, zero-cost, multi-format AI Quiz Assistant & Solver Chrome Extension with dual-model consensus, factual search grounding, and guardrailed automation.**

QuizZy is an intelligent Chrome Manifest V3 Side Panel extension backed by a local FastAPI service that solves online quizzes (MCQs, sequence ordering, and fill-in-the-blank) in real-time with sub-3-second p95 latency at $0 budget.

---

## 🚀 Key Features

- **Dual-Model Parallel Consensus**: Queries two independent open-weight models in parallel on Groq (`openai/gpt-oss-120b` and `qwen/qwen3.8-27b`) with OpenRouter `:free` tie-breaker.
- **Factual Search Grounding (SearXNG)**: Automatic factual contrastive query generation that rescues model disagreements with sub-second verified web snippets.
- **Order-Invariant Dynamic Cache**: Canonicalized SQLite cache that recognizes scrambled or permuted options and remaps solutions instantly in <30ms without poisoning.
- **Multi-Format Solving**:
  - **MCQ**: 2 to 6 options, True/False, and radio lists with fraction/math support (`1/6`, `2/36`).
  - **Order / Sequence**: Unlabelled drag-and-drop text blocks with pairwise swap guidance.
  - **Free-Text**: Fill-in-the-blank input box with normalization (articles, numbers, synonyms).
- **Chrome MV3 Side Panel Extension**:
  - **Zero-DOM-Mutation by default**: Purely read-only extraction with no intrusive element injection.
  - **Live React / MathJax / KaTeX Support**: Filters assistive MathML duplication and handles complex web-app DOMs (including `learning.ccbp.in`).
  - **Two-Step `SUBMIT` &rarr; `NEXT` Navigation**: Handles two-stage submission flows automatically.
- **Guardrailed Auto Mode**:
  - Own-app origin allowlist barrier.
  - Multi-trigger emergency Kill Switch (Escape key, Panic button, Background tab blur).
  - Hard question count limits (`max_steps`) and configurable step cooldowns.
  - Immediate halt on `uncertain` or low model consensus (Zero-Guessing Rule).
- **Feedback & Continuous Learning**:
  - 1-click wrong answer cache eviction.
  - User-verified answer overrides (100% confidence).
  - Auto-growing evaluation benchmark (`questions.csv`).
  - Weekly drift evaluation pipeline with recovery rate tracking.

---

## 🛠️ Architecture

```
QuizZy Chrome Side Panel (MV3)
   │
   ├── Extractor (Read-Only, Zero-DOM-Mutation, MathJax/KaTeX clean reader)
   ├── Executor (Radio/Text/Drag actions & 2-step SUBMIT -> NEXT advance)
   └── Background Service Worker (Isolated scripting, tab & feedback routing)
         │
         ▼ HTTP POST /solve, /feedback
FastAPI Local Backend (http://127.0.0.1:8000)
   │
   ├── SQLite Order-Invariant Cache (SHA-256 canonical hashing & dynamic remapping)
   ├── Dual Groq Primaries (openai/gpt-oss-120b & qwen/qwen3.8-27b in parallel)
   ├── OpenRouter Free Tie-Breaker (nvidia/nemotron-3-super-120b-a12b:free)
   ├── SearXNG Factual Grounding (Circuit breaker with instant fail-open)
   └── Feedback & Benchmark Pipeline (Weekly drift re-evaluation)
```

---

## 📦 Setup & Installation

### 1. Prerequisites
- Python 3.11+
- Google Chrome (or Chromium-based browser)
- Free API keys from [Groq](https://console.groq.com) and [OpenRouter](https://openrouter.ai)

### 2. Backend Setup
```bash
# Clone the repository
git clone https://github.com/codewithjaswanth/QuizZy.git
cd QuizZy

# Create and activate virtual environment
python -m venv .venv
# Windows:
.\.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure environment keys
copy backend\.env.example backend\.env
# Edit backend\.env with your GROQ_API_KEY and OPENROUTER_API_KEY
```

### 3. Run the Backend
```bash
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000 --reload
```

### 4. Load the Chrome Extension
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `extension/` folder inside this repository.
5. Click the QuizZy extension icon in the toolbar or open the Chrome Side Panel.

---

## 🧪 Testing & Verification

Run the comprehensive test suites:
```bash
# Phase 1: API & Order-Invariant Cache
python tests/test_phase1_api.py

# Phase 2: Chrome MV3 & Zero-DOM-Mutation Audit
python tests/test_phase2_extension.py

# Phase 3: Auto Mode & Guardrail Verification
python tests/test_phase3_automode.py

# Phase 4: SearXNG Grounding & Circuit Breaker
python tests/test_phase4_searxng.py

# Phase 5: Feedback, Eviction & Weekly Re-evaluation
python tests/test_phase5_feedback_reeval.py

# Live-Site Compatibility (React / KaTeX / Two-Step Submit)
python tests/test_live_site_compatibility.py
```

---

## 🔒 Security & Privacy

- **Zero Host Mutation**: The extractor never alters the target webpage's DOM tree, classes, or styles.
- **Zero Secrets in Git**: API keys are isolated in `backend/.env` which is strictly gitignored.
- **Local Isolation**: All cache databases and solve logs remain local to your machine.

---

## 📜 License
MIT License. Created by [Jaswanth](https://github.com/codewithjaswanth).