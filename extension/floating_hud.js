/**
 * QuizZy - Minimalist Draggable Glassmorphic Floating HUD Bar
 * 
 * Sleek, Shadow-DOM isolated on-page toolbar (~46px height).
 * Completely replaces the Chrome Side Panel in user workflows.
 */

(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") {
    const mockInstance = {
      isMock: true,
      isVisible: () => true,
      toggle: () => {},
      show: () => {},
      hide: () => {},
      destroy: () => {}
    };
    if (typeof module !== "undefined" && module.exports) {
      module.exports = mockInstance;
    }
    return { success: true, mounted: false, mock: true };
  }

  // Idempotency: Toggle visibility if instance already exists
  if (window.__QUIZZY_HUD_INSTANCE__) {
    const existing = window.__QUIZZY_HUD_INSTANCE__;
    existing.toggle();
    return {
      success: true,
      mounted: true,
      visible: existing.isVisible()
    };
  }

  const HOST_ID = "__quizzy_hud_host__";

  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-quizzy-ignore", "true");
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; pointer-events: none; overflow: visible;";
    
    if (document.documentElement) {
      document.documentElement.appendChild(host);
    } else if (document.body) {
      document.body.appendChild(host);
    }
  }

  let shadow = host.shadowRoot;
  if (!shadow) {
    try {
      shadow = host.attachShadow({ mode: "open" });
    } catch (_) {
      shadow = host.shadowRoot || host;
    }
  }

  // ==========================================================================
  // HUD Scoped Minimalist CSS Styles
  // ==========================================================================
  const HUD_STYLES = `
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    :host {
      all: initial;
    }

    .quizzy-hud-wrapper {
      position: fixed;
      pointer-events: auto;
      user-select: none;
      z-index: 2147483647;
      filter: drop-shadow(0 14px 34px rgba(0, 0, 0, 0.45)) drop-shadow(0 2px 6px rgba(0, 0, 0, 0.25));
      transition: opacity 140ms cubic-bezier(0.16, 1, 0.3, 1), transform 140ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .quizzy-hud-wrapper.hidden {
      display: none !important;
    }

    /* Minimalist Glassmorphic Bar (~46px compact height) */
    .hud-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 46px;
      min-width: 520px;
      max-width: 740px;
      padding: 0 10px 0 12px;
      background: rgba(15, 23, 42, 0.88);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 14px;
      color: #F8FAFC;
      cursor: grab;
      position: relative;
    }

    .hud-bar.dragging {
      cursor: grabbing;
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.6);
      transform: scale(1.01);
    }

    /* Left Status & Grip Group */
    .hud-grip-group {
      display: flex;
      align-items: center;
      gap: 7px;
      flex-shrink: 0;
    }

    .hud-grip-icon {
      color: #64748B;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 150ms;
    }

    .hud-bar:hover .hud-grip-icon {
      color: #94A3B8;
    }

    .hud-health-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #EF4444;
      box-shadow: 0 0 6px rgba(239, 68, 68, 0.5);
      transition: background 200ms, box-shadow 200ms;
    }

    .hud-health-dot.online {
      background: #10B981;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.7);
    }

    .hud-health-dot.solving {
      background: #A855F7;
      animation: hud-pulse 1.2s infinite ease-in-out;
    }

    @keyframes hud-pulse {
      0% { box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.7); }
      70% { box-shadow: 0 0 0 7px rgba(168, 85, 247, 0); }
      100% { box-shadow: 0 0 0 0 rgba(168, 85, 247, 0); }
    }

    /* Center Answer Zone */
    .hud-answer-zone {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 4px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      cursor: default;
    }

    .hud-badge-option {
      font-weight: 700;
      font-size: 12px;
      letter-spacing: 0.5px;
      padding: 2px 7px;
      border-radius: 6px;
      background: #7C3AED;
      color: #FFFFFF;
      flex-shrink: 0;
      box-shadow: 0 1px 4px rgba(124, 58, 237, 0.4);
    }

    .hud-badge-option.order {
      background: #0284C7;
    }

    .hud-badge-option.text {
      background: #D97706;
    }

    .hud-answer-text {
      font-size: 13px;
      font-weight: 500;
      color: #F8FAFC;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .hud-answer-text.ready {
      color: #94A3B8;
      font-weight: 400;
    }

    .hud-answer-text.solving {
      color: #C084FC;
      font-weight: 500;
    }

    .hud-answer-text.complete {
      color: #34D399;
      font-weight: 600;
    }

    .hud-answer-text.uncertain {
      color: #F87171;
    }

    .hud-pill-tag {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 4px;
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }

    .hud-tag-high {
      background: rgba(16, 185, 129, 0.2);
      color: #34D399;
      border: 1px solid rgba(16, 185, 129, 0.35);
    }

    .hud-tag-med {
      background: rgba(245, 158, 11, 0.2);
      color: #FBBF24;
      border: 1px solid rgba(245, 158, 11, 0.35);
    }

    .hud-tag-cache {
      background: rgba(6, 182, 212, 0.2);
      color: #38BDF8;
      border: 1px solid rgba(6, 182, 212, 0.35);
    }

    .hud-tag-latency {
      background: rgba(255, 255, 255, 0.06);
      color: #94A3B8;
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    /* Right Action Group */
    .hud-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .hud-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 32px;
      padding: 0 11px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      outline: none;
      transition: all 140ms ease-in-out;
      white-space: nowrap;
    }

    .hud-btn:focus-visible {
      box-shadow: 0 0 0 2px #38BDF8;
    }

    .hud-btn-primary {
      background: #7C3AED;
      color: #FFFFFF;
      box-shadow: 0 2px 8px rgba(124, 58, 237, 0.35);
    }

    .hud-btn-primary:hover:not(:disabled) {
      background: #6D28D9;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(124, 58, 237, 0.45);
    }

    .hud-btn-primary:active:not(:disabled) {
      background: #5B21B6;
      transform: translateY(0);
    }

    .hud-btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #E2E8F0;
      border: 1px solid rgba(255, 255, 255, 0.12);
    }

    .hud-btn-secondary:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.14);
      color: #FFFFFF;
      border-color: rgba(255, 255, 255, 0.2);
    }

    .hud-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }

    .hud-btn-auto {
      background: rgba(16, 185, 129, 0.15);
      color: #34D399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .hud-btn-auto:hover:not(:disabled) {
      background: rgba(16, 185, 129, 0.25);
      color: #6EE7B7;
    }

    .hud-btn-auto.running {
      background: #EF4444 !important;
      color: #FFFFFF !important;
      border: none !important;
      box-shadow: 0 0 12px rgba(239, 68, 68, 0.5) !important;
      animation: hud-auto-pulse 1s infinite alternate;
    }

    @keyframes hud-auto-pulse {
      0% { opacity: 0.9; }
      100% { opacity: 1; }
    }

    .hud-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: transparent;
      border: none;
      color: #94A3B8;
      cursor: pointer;
      transition: background 140ms, color 140ms;
    }

    .hud-icon-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #F8FAFC;
    }

    .hud-icon-btn:focus-visible {
      box-shadow: 0 0 0 2px #38BDF8;
    }

    /* More Popover Drawer */
    .hud-popover {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: rgba(15, 23, 42, 0.96);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      padding: 11px 14px;
      margin-top: 6px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.5);
      animation: hud-fade-in 140ms ease-out;
    }

    @keyframes hud-fade-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .hud-popover.hidden {
      display: none !important;
    }

    .hud-popover-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .hud-reason-text {
      font-size: 12px;
      color: #CBD5E1;
      line-height: 1.4;
      max-height: 48px;
      overflow-y: auto;
    }

    .hud-checkbox-label {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11.5px;
      color: #94A3B8;
      cursor: pointer;
    }

    .hud-checkbox-label input {
      accent-color: #7C3AED;
      cursor: pointer;
    }

    .hud-btn-flag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      padding: 0 9px;
      border-radius: 6px;
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #F87171;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      transition: background 140ms;
      flex-shrink: 0;
    }

    .hud-btn-flag:hover {
      background: rgba(239, 68, 68, 0.22);
    }

    .hud-btn-flag.flagged {
      background: rgba(16, 185, 129, 0.2);
      border-color: rgba(16, 185, 129, 0.4);
      color: #34D399;
    }

    /* Minimized 36x36px Floating Circle Pill */
    .hud-minimized-pill {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: rgba(15, 23, 42, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.18);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
      cursor: pointer;
      position: relative;
      transition: transform 140ms, box-shadow 140ms;
    }

    .hud-minimized-pill:hover {
      transform: scale(1.08);
      box-shadow: 0 10px 28px rgba(124, 58, 237, 0.35);
    }

    .hud-minimized-pill .hud-health-dot {
      position: absolute;
      top: 2px;
      right: 2px;
    }

    .hud-svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .hidden {
      display: none !important;
    }
  `;

  const styleEl = document.createElement("style");
  styleEl.textContent = HUD_STYLES;
  shadow.appendChild(styleEl);

  // ==========================================================================
  // HUD HTML Layout
  // ==========================================================================
  const wrapper = document.createElement("div");
  wrapper.className = "quizzy-hud-wrapper";
  wrapper.innerHTML = `
    <!-- Minimized Circle Pill (36x36px) -->
    <div class="hud-minimized-pill hidden" id="hud-min-pill" title="Expand QuizZy Floating Bar">
      <span class="hud-health-dot" id="hud-min-dot"></span>
      <svg class="hud-svg" viewBox="0 0 24 24" style="color: #A855F7;">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"></polygon>
      </svg>
    </div>

    <!-- Main Sleek Bar -->
    <div class="hud-bar" id="hud-bar" title="Drag to move bar">
      <!-- Left Grip & Status -->
      <div class="hud-grip-group">
        <div class="hud-grip-icon" title="Drag to move">
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="2" cy="2" r="1.5"></circle>
            <circle cx="2" cy="8" r="1.5"></circle>
            <circle cx="2" cy="14" r="1.5"></circle>
            <circle cx="8" cy="2" r="1.5"></circle>
            <circle cx="8" cy="8" r="1.5"></circle>
            <circle cx="8" cy="14" r="1.5"></circle>
          </svg>
        </div>
        <span class="hud-health-dot" id="hud-health-dot" title="Backend: Offline"></span>
      </div>

      <!-- Center Answer Zone -->
      <div class="hud-answer-zone" id="hud-answer-zone">
        <span class="hud-badge-option hidden" id="hud-badge-opt">[A]</span>
        <span class="hud-answer-text ready" id="hud-answer-text">Ready — Click Solve (Alt+S)</span>
        <span class="hud-pill-tag hud-tag-high hidden" id="hud-tag-conf">HIGH</span>
        <span class="hud-pill-tag hud-tag-cache hidden" id="hud-tag-cache">CACHE</span>
        <span class="hud-pill-tag hud-tag-latency hidden" id="hud-tag-latency">0ms</span>
      </div>

      <!-- Right Action Group -->
      <div class="hud-actions">
        <!-- Solve (Primary) -->
        <button class="hud-btn hud-btn-primary" id="hud-btn-solve" title="Extract & Solve Question (Alt+S)">
          <svg class="hud-svg" viewBox="0 0 24 24">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"></polygon>
          </svg>
          <span>Solve</span>
        </button>

        <!-- Apply (Secondary) -->
        <button class="hud-btn hud-btn-secondary" id="hud-btn-apply" title="Apply Winning Answer Once (Alt+A)" disabled>
          <svg class="hud-svg" viewBox="0 0 24 24">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Apply</span>
        </button>

        <!-- Auto Mode (Toggle) -->
        <button class="hud-btn hud-btn-auto" id="hud-btn-auto" title="Run guarded Auto Mode (Halt with Escape)">
          <svg class="hud-svg" id="hud-auto-icon" viewBox="0 0 24 24">
            <polygon points="5 3 19 12 5 21 5 3" fill="currentColor"></polygon>
          </svg>
          <span id="hud-auto-label">Auto</span>
        </button>

        <!-- More Drawer Toggle (⋯) -->
        <button class="hud-icon-btn" id="hud-btn-more" title="More Options & Reasoning">
          <svg class="hud-svg" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="1.5" fill="currentColor"></circle>
            <circle cx="19" cy="12" r="1.5" fill="currentColor"></circle>
            <circle cx="5" cy="12" r="1.5" fill="currentColor"></circle>
          </svg>
        </button>

        <!-- Minimize (—) -->
        <button class="hud-icon-btn" id="hud-btn-min" title="Minimize to Pill">
          <svg class="hud-svg" viewBox="0 0 24 24">
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
      </div>
    </div>

    <!-- More Popover Drawer (Reasoning, Flag Wrong, Strict Toggle) -->
    <div class="hud-popover hidden" id="hud-popover">
      <div class="hud-popover-row">
        <div class="hud-reason-text" id="hud-reason-text">No reasoning available yet. Click Solve to get explanations.</div>
        <button class="hud-btn-flag" id="hud-btn-flag" title="Flag as wrong and evict from cache">
          <svg class="hud-svg" viewBox="0 0 24 24" style="width: 12px; height: 12px;">
            <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path>
            <line x1="4" y1="22" x2="4" y2="15"></line>
          </svg>
          <span>Flag Wrong</span>
        </button>
      </div>
      <div class="hud-popover-row" style="border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 8px;">
        <label class="hud-checkbox-label">
          <input type="checkbox" id="hud-chk-strict">
          <span>Strict Mode: Pause on Tie-Breaker (Require Primary Agreement Only)</span>
        </label>
      </div>
    </div>
  `;

  shadow.appendChild(wrapper);

  // ==========================================================================
  // DOM References
  // ==========================================================================
  const getShadowEl = (id) => (shadow.getElementById ? shadow.getElementById(id) : shadow.querySelector("#" + id));
  const fullBar = getShadowEl("hud-bar");
  const minPill = getShadowEl("hud-min-pill");
  const healthDot = getShadowEl("hud-health-dot");
  const minDot = getShadowEl("hud-min-dot");
  const badgeOpt = getShadowEl("hud-badge-opt");
  const answerText = getShadowEl("hud-answer-text");
  const tagConf = getShadowEl("hud-tag-conf");
  const tagCache = getShadowEl("hud-tag-cache");
  const tagLatency = getShadowEl("hud-tag-latency");
  const btnSolve = getShadowEl("hud-btn-solve");
  const btnApply = getShadowEl("hud-btn-apply");
  const btnAuto = getShadowEl("hud-btn-auto");
  const autoIcon = getShadowEl("hud-auto-icon");
  const autoLabel = getShadowEl("hud-auto-label");
  const btnMore = getShadowEl("hud-btn-more");
  const btnMin = getShadowEl("hud-btn-min");
  const popover = getShadowEl("hud-popover");
  const reasonText = getShadowEl("hud-reason-text");
  const btnFlag = getShadowEl("hud-btn-flag");
  const chkStrict = getShadowEl("hud-chk-strict");

  // ==========================================================================
  // Internal State
  // ==========================================================================
  let isVisibleState = true;
  let isMinimizedState = false;
  let isSolving = false;
  let isAutoRunning = false;
  let autoStepCount = 0;
  let latestSolution = null;
  let latestExtracted = null;

  const storage = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local)
    ? chrome.storage.local
    : {
        get: (keys, cb) => { if (cb) cb({}); },
        set: (data, cb) => { if (cb) cb(); }
      };

  // Restore strict agreement preference (default: false)
  storage.get(["quizzy_strict_agreement"], (res) => {
    if (chkStrict && res.quizzy_strict_agreement !== undefined) {
      chkStrict.checked = Boolean(res.quizzy_strict_agreement);
    } else if (chkStrict) {
      chkStrict.checked = false;
    }
  });

  if (chkStrict) {
    chkStrict.addEventListener("change", () => {
      storage.set({ quizzy_strict_agreement: chkStrict.checked });
    });
  }

  // Restore position or set default (bottom-right: 24px)
  function applyPosition(pos) {
    const margin = 16;
    let x = (pos && typeof pos.left === "number") ? pos.left : (window.innerWidth - 640);
    let y = (pos && typeof pos.top === "number") ? pos.top : (window.innerHeight - 80);

    const maxX = Math.max(0, window.innerWidth - (isMinimizedState ? 44 : 540));
    const maxY = Math.max(0, window.innerHeight - (isMinimizedState ? 44 : 60));

    x = Math.max(margin, Math.min(x, maxX));
    y = Math.max(margin, Math.min(y, maxY));

    wrapper.style.left = `${x}px`;
    wrapper.style.top = `${y}px`;
  }

  storage.get(["quizzy_hud_pos", "quizzy_hud_minimized"], (res) => {
    if (res.quizzy_hud_minimized) {
      setMinimized(true);
    }
    applyPosition(res.quizzy_hud_pos);
  });

  // ==========================================================================
  // Dragging Implementation (Anywhere on Bar, Except Interactive Elements)
  // ==========================================================================
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let barStartLeft = 0;
  let barStartTop = 0;

  function onDragStart(e) {
    // Ignore drag on buttons, inputs, labels, and popover content
    const target = e.target;
    if (target && target.closest && target.closest("button, input, label, a, .hud-btn-flag, .hud-popover")) {
      return;
    }

    isDragging = true;
    fullBar.classList.add("dragging");

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartX = clientX;
    dragStartY = clientY;

    const rect = wrapper.getBoundingClientRect();
    barStartLeft = rect.left;
    barStartTop = rect.top;

    window.addEventListener("mousemove", onDragMove, { passive: true });
    window.addEventListener("mouseup", onDragEnd);
    window.addEventListener("touchmove", onDragMove, { passive: true });
    window.addEventListener("touchend", onDragEnd);
  }

  function onDragMove(e) {
    if (!isDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;

    let newLeft = barStartLeft + dx;
    let newTop = barStartTop + dy;

    const w = wrapper.offsetWidth || 520;
    const h = wrapper.offsetHeight || 46;
    newLeft = Math.max(8, Math.min(newLeft, window.innerWidth - w - 8));
    newTop = Math.max(8, Math.min(newTop, window.innerHeight - h - 8));

    wrapper.style.left = `${newLeft}px`;
    wrapper.style.top = `${newTop}px`;
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    fullBar.classList.remove("dragging");

    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
    window.removeEventListener("touchmove", onDragMove);
    window.removeEventListener("touchend", onDragEnd);

    const rect = wrapper.getBoundingClientRect();
    storage.set({ quizzy_hud_pos: { left: rect.left, top: rect.top } });
  }

  if (fullBar) {
    fullBar.addEventListener("mousedown", onDragStart);
    fullBar.addEventListener("touchstart", onDragStart, { passive: false });
  }
  if (minPill) {
    minPill.addEventListener("mousedown", onDragStart);
    minPill.addEventListener("touchstart", onDragStart, { passive: false });
  }

  // ==========================================================================
  // Communication Helpers
  // ==========================================================================
  function sendExtensionMessage(message, callback) {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            if (callback) callback({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          if (callback) callback(res || { success: false });
        });
        return;
      } catch (err) {
        if (callback) callback({ success: false, error: err.message });
        return;
      }
    }
    if (callback) callback({ success: false, error: "chrome.runtime unavailable" });
  }

  // ==========================================================================
  // Health Polling (Backend Status)
  // ==========================================================================
  function checkHealth() {
    sendExtensionMessage({ action: "CHECK_HEALTH" }, (res) => {
      const isOnline = res && res.success && res.data;
      if (isOnline) {
        if (healthDot && !isSolving) {
          healthDot.className = "hud-health-dot online";
          healthDot.title = `Backend Connected (Cache: ${res.data.cache_entries || 0})`;
        }
        if (minDot) minDot.className = "hud-health-dot online";
      } else {
        if (healthDot && !isSolving) {
          healthDot.className = "hud-health-dot";
          healthDot.title = "Backend Offline";
        }
        if (minDot) minDot.className = "hud-health-dot";
      }
    });
  }

  checkHealth();
  const healthInterval = setInterval(checkHealth, 7000);
  if (healthInterval && typeof healthInterval.unref === "function") {
    healthInterval.unref();
  }

  // ==========================================================================
  // Question Signature for Stuck-Detection
  // ==========================================================================
  function getQuestionSig(ext) {
    if (!ext) return "";
    const q = (ext.question || "").trim();
    const opts = Array.isArray(ext.options) ? ext.options.join("|") : "";
    return `${q}::${opts}`;
  }

  // ==========================================================================
  // Display & State Renderers
  // ==========================================================================
  function setSolvingState() {
    isSolving = true;
    if (healthDot) healthDot.className = "hud-health-dot solving";
    if (badgeOpt) badgeOpt.classList.add("hidden");
    if (answerText) {
      answerText.className = "hud-answer-text solving";
      answerText.textContent = "Solving question with dual models...";
    }
    if (tagConf) tagConf.classList.add("hidden");
    if (tagCache) tagCache.classList.add("hidden");
    if (tagLatency) tagLatency.classList.add("hidden");
    if (btnApply) btnApply.disabled = true;
  }

  function renderSolution(solution, extracted) {
    isSolving = false;
    latestSolution = solution;
    latestExtracted = extracted;
    checkHealth();

    if (!solution || solution.status !== "ok") {
      if (badgeOpt) badgeOpt.classList.add("hidden");
      if (answerText) {
        answerText.className = "hud-answer-text uncertain";
        answerText.textContent = solution && solution.reason ? solution.reason : "Model consensus uncertain";
      }
      if (tagConf) tagConf.classList.add("hidden");
      if (tagCache) tagCache.classList.add("hidden");
      if (tagLatency) tagLatency.classList.add("hidden");
      if (btnApply) btnApply.disabled = true;
      if (reasonText) reasonText.textContent = solution && solution.reason ? solution.reason : "Uncertain consensus";
      return;
    }

    // Set Option Badge
    let optBadge = "[A]";
    let winText = "";

    if (solution.q_type === "mcq") {
      optBadge = `[${solution.answer || "A"}]`;
      winText = solution.selected_text || (extracted && extracted.options && extracted.options[solution.selected_index]) || "Option";
      if (badgeOpt) badgeOpt.className = "hud-badge-option";
    } else if (solution.q_type === "order") {
      optBadge = "[Order]";
      winText = Array.isArray(solution.ordered_texts) ? solution.ordered_texts.join(" ➔ ") : (solution.answer || "Sequence");
      if (badgeOpt) badgeOpt.className = "hud-badge-option order";
    } else if (solution.q_type === "text") {
      optBadge = "[Text]";
      winText = solution.answer || "Answer";
      if (badgeOpt) badgeOpt.className = "hud-badge-option text";
    }

    if (badgeOpt) {
      badgeOpt.textContent = optBadge;
      badgeOpt.classList.remove("hidden");
    }

    if (answerText) {
      answerText.className = "hud-answer-text";
      answerText.textContent = winText;
      answerText.title = winText;
    }

    // Confidence badge
    if (tagConf) {
      const conf = (solution.confidence_label || "high").toUpperCase();
      tagConf.textContent = conf;
      tagConf.className = `hud-pill-tag ${conf === "HIGH" ? "hud-tag-high" : "hud-tag-med"}`;
      tagConf.classList.remove("hidden");
    }

    // Cache badge
    if (tagCache) {
      if (solution.cache_hit) {
        tagCache.classList.remove("hidden");
      } else {
        tagCache.classList.add("hidden");
      }
    }

    // Latency badge
    if (tagLatency) {
      if (solution.latency_ms) {
        tagLatency.textContent = `${Math.round(solution.latency_ms)}ms`;
        tagLatency.classList.remove("hidden");
      } else {
        tagLatency.classList.add("hidden");
      }
    }

    // Reasoning popover
    if (reasonText) {
      reasonText.textContent = solution.reason || "High confidence consensus reached.";
    }

    // Enable Apply button
    if (btnApply) btnApply.disabled = false;
  }

  // ==========================================================================
  // Core Actions: Solve & Apply
  // ==========================================================================
  function solveCurrentQuestion(callback) {
    if (isSolving) return;
    setSolvingState();

    // 1. Extract from page via global extractor
    let extracted = null;
    if (window.__QuizZyExtractor && typeof window.__QuizZyExtractor.extractQuizFromDom === "function") {
      extracted = window.__QuizZyExtractor.extractQuizFromDom(document);
    }

    if (!extracted || !extracted.success) {
      sendExtensionMessage({ action: "EXTRACT_QUIZ" }, (res) => {
        if (!res || !res.success || !res.data) {
          isSolving = false;
          checkHealth();
          if (answerText) {
            answerText.className = "hud-answer-text uncertain";
            answerText.textContent = "Could not find quiz question on page";
          }
          if (callback) callback(null, null);
          return;
        }
        dispatchSolveRequest(res.data, callback);
      });
      return;
    }

    dispatchSolveRequest(extracted, callback);
  }

  function dispatchSolveRequest(extracted, callback) {
    const payload = {
      subject: extracted.subject || "General",
      q_type: extracted.q_type || "mcq",
      question: extracted.question,
      options: extracted.options || []
    };

    sendExtensionMessage({ action: "SOLVE_REQUEST", payload }, (res) => {
      if (!res || !res.success || !res.data) {
        isSolving = false;
        checkHealth();
        if (answerText) {
          answerText.className = "hud-answer-text uncertain";
          answerText.textContent = res && res.error ? res.error : "Backend solve error";
        }
        if (callback) callback(null, extracted);
        return;
      }

      renderSolution(res.data, extracted);
      if (callback) callback(res.data, extracted);
    });
  }

  function applyCurrentSolution(callback) {
    if (!latestSolution || latestSolution.status !== "ok") {
      if (callback) callback({ success: false, reason: "No valid solution to apply" });
      return;
    }

    const qType = (latestSolution.q_type || "mcq").toLowerCase();
    let targetIdx = (typeof latestSolution.selected_index === "number" && latestSolution.selected_index >= 0)
      ? latestSolution.selected_index
      : null;

    let syntheticLetter = "";
    if (typeof latestSolution.letter === "string" && /^[A-F]$/i.test(latestSolution.letter.trim())) {
      syntheticLetter = latestSolution.letter.trim().toUpperCase();
    } else if (typeof latestSolution.canonical_key === "string" && /^[A-F]$/i.test(latestSolution.canonical_key.trim())) {
      syntheticLetter = latestSolution.canonical_key.trim().toUpperCase();
    } else if (typeof latestSolution.answer === "string" && /^[A-F]$/i.test(latestSolution.answer.trim())) {
      syntheticLetter = latestSolution.answer.trim().toUpperCase();
    }

    if (targetIdx === null && syntheticLetter) {
      targetIdx = syntheticLetter.charCodeAt(0) - 65;
    }

    const resolvedLetter = syntheticLetter || (targetIdx !== null ? String.fromCharCode(65 + targetIdx) : "");
    const resolvedText = latestSolution.selected_text ||
      (latestExtracted && Array.isArray(latestExtracted.options) && targetIdx !== null ? latestExtracted.options[targetIdx] : "") ||
      (latestSolution.answer && !/^[A-F]$/i.test(String(latestSolution.answer).trim()) ? latestSolution.answer : "");

    const actionPayload = {
      question_type: qType,
      q_type: qType,
      targetIndex: targetIdx,
      selected_index: targetIdx,
      targetText: resolvedText,
      selected_text: resolvedText,
      answer: (qType === "mcq" && resolvedText) ? resolvedText : latestSolution.answer,
      letter: resolvedLetter,
      ordered_indices: latestSolution.ordered_indices,
      ordered_texts: latestSolution.ordered_texts,
      target_permutation: latestSolution.ordered_indices,
      permutation_indices: latestSolution.permutation_indices
    };

    const exec = window.__QuizZyExecutor || window.QuizZyExecutor;
    if (exec && (typeof exec.executeQuizAction === "function" || typeof exec.executeAction === "function")) {
      try {
        const fn = exec.executeQuizAction || exec.executeAction;
        const res = fn.call(exec, actionPayload);
        if (callback) callback(res);
        return;
      } catch (err) {
        console.error("[QuizZy HUD] Direct executor call failed:", err);
      }
    }

    sendExtensionMessage({ action: "EXECUTE_ACTION", payload: actionPayload }, (res) => {
      if (callback) callback(res);
    });
  }

  function clickNextOnPage(callback) {
    const exec = window.__QuizZyExecutor || window.QuizZyExecutor;
    if (exec && typeof exec.clickNextButton === "function") {
      exec.clickNextButton().then((res) => {
        if (callback) callback(res);
      }).catch((err) => {
        if (callback) callback({ ok: false, error: err.message });
      });
      return;
    }

    sendExtensionMessage({ action: "CLICK_NEXT_BUTTON" }, (res) => {
      if (callback) callback(res && res.result ? res.result : res);
    });
  }

  // ==========================================================================
  // Self-Sufficient Auto Mode
  // ==========================================================================
  function updateAutoButtonState(running) {
    if (!btnAuto) return;
    if (running) {
      btnAuto.className = "hud-btn hud-btn-auto running";
      if (autoLabel) autoLabel.textContent = "Stop";
      if (autoIcon) {
        autoIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" fill="currentColor"></rect>';
      }
    } else {
      btnAuto.className = "hud-btn hud-btn-auto";
      if (autoLabel) autoLabel.textContent = "Auto";
      if (autoIcon) {
        autoIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3" fill="currentColor"></polygon>';
      }
    }
  }

  function startAutoMode() {
    isAutoRunning = true;
    autoStepCount = 0;
    updateAutoButtonState(true);

    // Auto-allowlist the current host so user never needs a settings panel
    const currentHost = (window.location && window.location.hostname) ? window.location.hostname.toLowerCase() : "";
    if (currentHost && storage && storage.get) {
      storage.get(["allowedHosts"], (data) => {
        const list = data.allowedHosts || [];
        if (!list.includes(currentHost)) {
          list.push(currentHost);
          storage.set({ allowedHosts: list });
        }
      });
    }

    runAutoStep();
  }

  function stopAutoMode(message) {
    isAutoRunning = false;
    updateAutoButtonState(false);
    if (message && answerText) {
      if (message.includes("Completed")) {
        answerText.className = "hud-answer-text complete";
      } else {
        answerText.className = "hud-answer-text ready";
      }
      answerText.textContent = message;
    }
  }

  function runAutoStep() {
    if (!isAutoRunning) return;

    if (autoStepCount >= 100) {
      stopAutoMode("Auto Mode reached 100-step limit.");
      return;
    }
    autoStepCount++;

    solveCurrentQuestion((solution, extracted) => {
      if (!isAutoRunning) return;

      if (!solution || solution.status !== "ok") {
        stopAutoMode("Model consensus uncertain. Auto Mode stopped.");
        return;
      }

      // Check strict HIGH agreement constraint
      if (chkStrict && chkStrict.checked) {
        const isHigh = solution.confidence_label === "high" || solution.agreement_status === "both_agree";
        if (!isHigh) {
          stopAutoMode("Strict HIGH agreement required. Auto Mode stopped.");
          return;
        }
      }

      const prevSig = getQuestionSig(extracted);

      // Apply answer once
      applyCurrentSolution((applyRes) => {
        if (!isAutoRunning) return;

        // Brief delay before clicking Submit / Next
        setTimeout(() => {
          if (!isAutoRunning) return;

          clickNextOnPage((nextRes) => {
            if (!isAutoRunning) return;

            if (nextRes && nextRes.step === "quiz_completed") {
              stopAutoMode("Quiz Completed!");
              return;
            }

            // Poll for question advance using composite signature
            let pollAttempts = 0;
            const pollInterval = setInterval(() => {
              if (!isAutoRunning) {
                clearInterval(pollInterval);
                return;
              }

              pollAttempts++;
              let currentExt = null;
              if (window.__QuizZyExtractor && typeof window.__QuizZyExtractor.extractQuizFromDom === "function") {
                currentExt = window.__QuizZyExtractor.extractQuizFromDom(document);
              }

              const newSig = getQuestionSig(currentExt);
              if (newSig && newSig !== prevSig) {
                clearInterval(pollInterval);
                setTimeout(runAutoStep, 400);
                return;
              }

              if (pollAttempts >= 25) { // 25 * 400ms = 10s timeout
                clearInterval(pollInterval);
                stopAutoMode("Question did not advance after submit.");
              }
            }, 400);
          });
        }, 500);
      });
    });
  }

  // ==========================================================================
  // UI Interactions (Buttons, Drawer, Minimize)
  // ==========================================================================
  function setMinimized(minimized) {
    isMinimizedState = minimized;
    storage.set({ quizzy_hud_minimized: minimized });
    if (minimized) {
      if (fullBar) fullBar.classList.add("hidden");
      if (popover) popover.classList.add("hidden");
      if (minPill) minPill.classList.remove("hidden");
    } else {
      if (minPill) minPill.classList.add("hidden");
      if (fullBar) fullBar.classList.remove("hidden");
    }
  }

  function toggleVisibility() {
    isVisibleState = !isVisibleState;
    if (isVisibleState) {
      wrapper.classList.remove("hidden");
    } else {
      wrapper.classList.add("hidden");
      stopAutoMode();
    }
    return isVisibleState;
  }

  function show() {
    isVisibleState = true;
    wrapper.classList.remove("hidden");
  }

  function hide() {
    isVisibleState = false;
    wrapper.classList.add("hidden");
    stopAutoMode();
  }

  if (btnSolve) {
    btnSolve.addEventListener("click", () => solveCurrentQuestion());
  }

  if (btnApply) {
    btnApply.addEventListener("click", () => applyCurrentSolution());
  }

  if (btnAuto) {
    btnAuto.addEventListener("click", () => {
      if (isAutoRunning) {
        stopAutoMode("Auto Mode stopped.");
      } else {
        startAutoMode();
      }
    });
  }

  if (btnMore) {
    btnMore.addEventListener("click", () => {
      if (popover) popover.classList.toggle("hidden");
    });
  }

  if (btnMin) {
    btnMin.addEventListener("click", () => setMinimized(true));
  }

  if (minPill) {
    minPill.addEventListener("click", () => setMinimized(false));
  }

  if (btnFlag) {
    btnFlag.addEventListener("click", () => {
      if (!latestSolution || !latestExtracted) return;
      btnFlag.disabled = true;

      const payload = {
        subject: latestExtracted.subject || "General",
        q_type: latestExtracted.q_type || "mcq",
        question: latestExtracted.question,
        options: latestExtracted.options || [],
        wrong_answer: latestSolution.answer,
        is_unverified_flag: true
      };

      sendExtensionMessage({ action: "SUBMIT_FEEDBACK", payload }, (res) => {
        btnFlag.disabled = false;
        if (res && res.success) {
          btnFlag.className = "hud-btn-flag flagged";
          btnFlag.innerHTML = "<span>✓ Evicted</span>";
          if (answerText) {
            answerText.className = "hud-answer-text ready";
            answerText.textContent = "Answer flagged wrong. Cache evicted.";
          }
        }
      });
    });
  }

  // ==========================================================================
  // Keyboard Shortcuts (Alt+S, Alt+A, Escape)
  // ==========================================================================
  function onKeyDown(e) {
    if (e.key === "Escape" || e.key === "Esc") {
      if (isAutoRunning) {
        stopAutoMode("Escape key pressed.");
        e.preventDefault();
        return;
      }
    }
    if (e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      solveCurrentQuestion();
      return;
    }
    if (e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      applyCurrentSolution();
      return;
    }
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("keydown", onKeyDown, true);
  }

  // Runtime message listener for background commands
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.action) return;
      if (message.action === "KILL_SWITCH_TRIGGERED") {
        if (isAutoRunning) {
          stopAutoMode(message.reason || "Kill switch triggered.");
        }
      }
      if (message.action === "TOGGLE_FLOATING_HUD_COMMAND") {
        toggleVisibility();
      }
      if (message.action === "SHOW_FLOATING_HUD_COMMAND") {
        show();
      }
    });
  }

  // ==========================================================================
  // Public Instance Definition
  // ==========================================================================
  const hudInstance = {
    host,
    shadow,
    wrapper,
    isVisible: () => isVisibleState,
    toggle: toggleVisibility,
    show,
    hide,
    setMinimized,
    solve: solveCurrentQuestion,
    apply: applyCurrentSolution,
    startAuto: startAutoMode,
    stopAuto: stopAutoMode,
    destroy: () => {
      clearInterval(healthInterval);
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("keydown", onKeyDown, true);
      }
      if (host && host.parentNode) {
        host.parentNode.removeChild(host);
      }
      delete window.__QUIZZY_HUD_INSTANCE__;
    }
  };

  window.__QUIZZY_HUD_INSTANCE__ = hudInstance;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = hudInstance;
  }

  return {
    success: true,
    mounted: true,
    visible: isVisibleState
  };
})();
