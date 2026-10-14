/**
 * QuizZy - Compact Rectangular Floating Bar & Movable White Dot HUD
 * 
 * Crisp, Shadow-DOM isolated on-page toolbar (~36px height, dark slate #111827).
 * Featuring Movable White Dot mode (double-tap Z or double-click dot)
 * and double-tap hotkeys (Ctrl, Z/Alt, Fn/Shift).
 */

(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") {
    const mockInstance = {
      isMock: true,
      isVisible: () => true,
      isHidden: () => false,
      isMinimized: () => false,
      toggle: () => {},
      show: () => {},
      hide: () => {},
      setMinimized: () => {},
      setHidden: () => {},
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
  // HUD Scoped Compact Rectangular & White Dot CSS Styles
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
      box-shadow: none;
      filter: none;
      transition: opacity 120ms ease, transform 120ms ease;
    }

    .quizzy-hud-wrapper.hidden {
      display: none !important;
    }

    /* Compact Rectangular Bar (~36px height) */
    .hud-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 36px;
      min-width: 260px;
      max-width: 440px;
      padding: 4px 8px;
      background: #111827;
      border: 1px solid #374151;
      border-radius: 6px;
      color: #F9FAFB;
      cursor: grab;
      position: relative;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    }

    .hud-bar.dragging {
      cursor: grabbing;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
    }

    /* Very Small Movable White Dot (9x9px) with Dark Border */
    .hud-mini-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #ffffff;
      border: 1.5px solid #111827;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
      cursor: grab;
      user-select: none;
      transition: transform 0.12s ease;
      display: block;
      position: relative;
      box-sizing: border-box;
    }

    /* Generous invisible grab zone so the tiny dot is effortless to drag & click */
    .hud-mini-dot::before {
      content: "";
      position: absolute;
      top: -9px;
      left: -9px;
      right: -9px;
      bottom: -9px;
      border-radius: 50%;
      cursor: grab;
    }

    .hud-mini-dot:hover {
      transform: scale(1.35);
    }

    .hud-mini-dot.dragging {
      cursor: grabbing;
      transform: scale(1.5);
    }

    .hud-mini-dot.auto-running {
      border-color: #10B981;
      box-shadow: 0 0 6px rgba(16, 185, 129, 0.85);
      animation: hud-dot-pulse 1s infinite alternate;
    }

    @keyframes hud-dot-pulse {
      0% { transform: scale(1); }
      100% { transform: scale(1.4); }
    }

    /* Left Status Dot */
    .hud-grip-group {
      display: flex;
      align-items: center;
      flex-shrink: 0;
      padding: 0 2px;
    }

    .hud-health-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #EF4444;
      box-shadow: 0 0 4px rgba(239, 68, 68, 0.5);
      transition: background 200ms;
    }

    .hud-health-dot.online {
      background: #10B981;
      box-shadow: 0 0 5px rgba(16, 185, 129, 0.6);
    }

    .hud-health-dot.solving {
      background: #A855F7;
      animation: hud-pulse 1.2s infinite ease-in-out;
    }

    @keyframes hud-pulse {
      0% { box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.7); }
      70% { box-shadow: 0 0 0 5px rgba(168, 85, 247, 0); }
      100% { box-shadow: 0 0 0 0 rgba(168, 85, 247, 0); }
    }

    /* Center Answer Zone */
    .hud-answer-zone {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 2px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      cursor: default;
    }

    .hud-badge-option {
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      letter-spacing: 0.3px;
      padding: 1px 5px;
      border-radius: 3px;
      background: #7C3AED;
      color: #FFFFFF;
      flex-shrink: 0;
    }

    .hud-badge-option.order {
      background: #0284C7;
    }

    .hud-badge-option.text {
      background: #D97706;
    }

    .hud-answer-text {
      font-size: 12.5px;
      font-weight: 500;
      color: #F9FAFB;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .hud-answer-text.ready {
      color: #9CA3AF;
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
      font-size: 9.5px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
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
      gap: 4px;
      flex-shrink: 0;
    }

    .hud-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      outline: none;
      transition: all 120ms ease-in-out;
      white-space: nowrap;
    }

    .hud-btn:focus-visible {
      box-shadow: 0 0 0 2px #38BDF8;
    }

    .hud-btn-primary {
      background: #7C3AED;
      color: #FFFFFF;
    }

    .hud-btn-primary:hover:not(:disabled) {
      background: #6D28D9;
    }

    .hud-btn-secondary {
      background: #1F2937;
      color: #E5E7EB;
      border: 1px solid #374151;
    }

    .hud-btn-secondary:hover:not(:disabled) {
      background: #374151;
      color: #FFFFFF;
    }

    .hud-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
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
      box-shadow: 0 0 8px rgba(239, 68, 68, 0.5) !important;
      animation: hud-auto-pulse 1s infinite alternate;
    }

    @keyframes hud-auto-pulse {
      0% { opacity: 0.85; }
      100% { opacity: 1; }
    }

    .hud-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      background: transparent;
      border: none;
      color: #9CA3AF;
      cursor: pointer;
      transition: background 120ms, color 120ms;
    }

    .hud-icon-btn:hover {
      background: #1F2937;
      color: #F9FAFB;
    }

    /* More Popover Drawer */
    .hud-popover {
      display: flex;
      flex-direction: column;
      gap: 6px;
      background: #111827;
      border: 1px solid #374151;
      border-radius: 6px;
      padding: 8px 10px;
      margin-top: 4px;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
      animation: hud-fade-in 120ms ease-out;
    }

    @keyframes hud-fade-in {
      from { opacity: 0; transform: translateY(-3px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .hud-popover.hidden {
      display: none !important;
    }

    .hud-popover-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .hud-reason-text {
      font-size: 11.5px;
      color: #CBD5E1;
      line-height: 1.35;
      max-height: 48px;
      overflow-y: auto;
    }

    .hud-checkbox-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: #9CA3AF;
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
      height: 24px;
      padding: 0 8px;
      border-radius: 4px;
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #F87171;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
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

    .hud-svg {
      width: 13px;
      height: 13px;
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
    <!-- Very Small Movable White Dot (9x9px) with Dark Border -->
    <div class="hud-mini-dot hidden" id="hud-mini-dot" title="Double-click or double-tap Z to expand QuizZy"></div>

    <!-- Main Compact Rectangular Bar (~36px height) -->
    <div class="hud-bar" id="hud-full-bar" title="Drag to move bar">
      <!-- Left Status -->
      <div class="hud-grip-group">
        <span class="hud-health-dot" id="hud-health-dot" title="Backend: Offline"></span>
      </div>

      <!-- Center Answer Zone -->
      <div class="hud-answer-zone" id="hud-answer-zone">
        <span class="hud-badge-option hidden" id="hud-badge-opt">[A]</span>
        <span class="hud-answer-text ready" id="hud-answer-text" title="Ready">Ready — Click Solve (Alt+S)</span>
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
        <button class="hud-btn hud-btn-auto" id="hud-btn-auto" title="Auto Mode (Double-tap Fn or Shift)">
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

        <!-- Minimize to Dot (—) -->
        <button class="hud-icon-btn" id="hud-btn-min" title="Shrink to Dot (Double-tap Z)">
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
      <div class="hud-popover-row" style="border-top: 1px solid rgba(255, 255, 255, 0.08); padding-top: 6px;">
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
  const fullBar = getShadowEl("hud-full-bar") || getShadowEl("hud-bar");
  const miniDot = getShadowEl("hud-mini-dot") || getShadowEl("hud-min-pill");
  const healthDot = getShadowEl("hud-health-dot");
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
  let isHiddenState = false;
  let isMinimizedState = false;
  let isSolving = false;
  let isAutoRunning = false;
  let autoStepCount = 0;
  let autoRetryCount = 0;
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

  // Restore position or set default
  function applyBarPosition(pos) {
    const margin = 16;
    let x = (pos && typeof pos.left === "number") ? pos.left : (window.innerWidth - 420);
    let y = (pos && typeof pos.top === "number") ? pos.top : (window.innerHeight - 60);

    const barW = fullBar ? (fullBar.offsetWidth || 340) : 340;
    const barH = fullBar ? (fullBar.offsetHeight || 36) : 36;
    const maxX = Math.max(0, window.innerWidth - barW - 8);
    const maxY = Math.max(0, window.innerHeight - barH - 8);

    x = Math.max(margin, Math.min(x, maxX));
    y = Math.max(margin, Math.min(y, maxY));

    wrapper.style.left = `${x}px`;
    wrapper.style.top = `${y}px`;
  }

  function applyDotPosition(pos) {
    let x = (pos && typeof pos.left === "number") ? pos.left : (window.innerWidth - 20);
    let y = (pos && typeof pos.top === "number") ? pos.top : (window.innerHeight - 20);

    const maxX = Math.max(0, window.innerWidth - 14);
    const maxY = Math.max(0, window.innerHeight - 14);

    x = Math.max(6, Math.min(x, maxX));
    y = Math.max(6, Math.min(y, maxY));

    wrapper.style.left = `${x}px`;
    wrapper.style.top = `${y}px`;
  }

  storage.get(["quizzy_hud_pos", "quizzy_dot_pos", "quizzy_hud_minimized"], (res) => {
    if (res.quizzy_hud_minimized) {
      setMinimized(true);
    } else {
      applyBarPosition(res.quizzy_hud_pos);
    }
  });

  // ==========================================================================
  // Dragging Implementation for Bar & White Dot
  // ==========================================================================
  let isBarDragging = false;
  let isDotDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let startLeft = 0;
  let startTop = 0;
  let dotDragDistance = 0;

  function onBarDragStart(e) {
    const target = e.target;
    if (target && target.closest && target.closest("button, input, label, a, .hud-btn-flag, .hud-popover")) {
      return;
    }

    isBarDragging = true;
    if (fullBar) fullBar.classList.add("dragging");

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartX = clientX;
    dragStartY = clientY;

    const rect = wrapper.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    window.addEventListener("mousemove", onBarDragMove, { passive: true });
    window.addEventListener("mouseup", onBarDragEnd);
    window.addEventListener("touchmove", onBarDragMove, { passive: true });
    window.addEventListener("touchend", onBarDragEnd);
  }

  function onBarDragMove(e) {
    if (!isBarDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;

    let newLeft = startLeft + dx;
    let newTop = startTop + dy;

    const w = wrapper.offsetWidth || 340;
    const h = wrapper.offsetHeight || 36;
    newLeft = Math.max(8, Math.min(newLeft, window.innerWidth - w - 8));
    newTop = Math.max(8, Math.min(newTop, window.innerHeight - h - 8));

    wrapper.style.left = `${newLeft}px`;
    wrapper.style.top = `${newTop}px`;
  }

  function onBarDragEnd() {
    if (!isBarDragging) return;
    isBarDragging = false;
    if (fullBar) fullBar.classList.remove("dragging");

    window.removeEventListener("mousemove", onBarDragMove);
    window.removeEventListener("mouseup", onBarDragEnd);
    window.removeEventListener("touchmove", onBarDragMove);
    window.removeEventListener("touchend", onBarDragEnd);

    const rect = wrapper.getBoundingClientRect();
    storage.set({ quizzy_hud_pos: { left: rect.left, top: rect.top } });
  }

  function onDotDragStart(e) {
    isDotDragging = true;
    dotDragDistance = 0;
    if (miniDot) miniDot.classList.add("dragging");

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragStartX = clientX;
    dragStartY = clientY;

    const rect = wrapper.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    window.addEventListener("mousemove", onDotDragMove, { passive: true });
    window.addEventListener("mouseup", onDotDragEnd);
    window.addEventListener("touchmove", onDotDragMove, { passive: true });
    window.addEventListener("touchend", onDotDragEnd);
  }

  function onDotDragMove(e) {
    if (!isDotDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;
    dotDragDistance = Math.hypot(dx, dy);

    let newLeft = startLeft + dx;
    let newTop = startTop + dy;

    newLeft = Math.max(6, Math.min(newLeft, window.innerWidth - 14));
    newTop = Math.max(6, Math.min(newTop, window.innerHeight - 14));

    wrapper.style.left = `${newLeft}px`;
    wrapper.style.top = `${newTop}px`;
  }

  function onDotDragEnd() {
    if (!isDotDragging) return;
    isDotDragging = false;
    if (miniDot) miniDot.classList.remove("dragging");

    window.removeEventListener("mousemove", onDotDragMove);
    window.removeEventListener("mouseup", onDotDragEnd);
    window.removeEventListener("touchmove", onDotDragMove);
    window.removeEventListener("touchend", onDotDragEnd);

    if (dotDragDistance >= 5) {
      const rect = wrapper.getBoundingClientRect();
      storage.set({ quizzy_dot_pos: { left: rect.left, top: rect.top } });
    }
  }

  if (fullBar) {
    fullBar.addEventListener("mousedown", onBarDragStart);
    fullBar.addEventListener("touchstart", onBarDragStart, { passive: false });
  }

  if (miniDot) {
    miniDot.addEventListener("mousedown", onDotDragStart);
    miniDot.addEventListener("touchstart", onDotDragStart, { passive: false });
    miniDot.addEventListener("dblclick", (e) => {
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      setMinimized(false);
    });
    miniDot.addEventListener("click", (e) => {
      if (dotDragDistance < 5) {
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        setMinimized(false);
      }
    });
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
      } else {
        if (healthDot && !isSolving) {
          healthDot.className = "hud-health-dot";
          healthDot.title = "Backend Offline";
        }
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

    const hasCandidate = solution && (
      (typeof solution.selected_index === "number" && solution.selected_index >= 0) ||
      (typeof solution.answer === "string" && solution.answer.trim().length > 0) ||
      (typeof solution.canonical_key === "string" && solution.canonical_key.trim().length > 0) ||
      (typeof solution.letter === "string" && solution.letter.trim().length > 0) ||
      (typeof solution.selected_text === "string" && solution.selected_text.trim().length > 0)
    );

    if (!hasCandidate) {
      if (badgeOpt) badgeOpt.classList.add("hidden");
      if (answerText) {
        answerText.className = "hud-answer-text uncertain";
        answerText.textContent = solution && solution.error ? solution.error : "Model consensus uncertain";
        answerText.title = answerText.textContent;
      }
      if (tagConf) tagConf.classList.add("hidden");
      if (tagCache) tagCache.classList.add("hidden");
      if (tagLatency) tagLatency.classList.add("hidden");
      if (btnApply) btnApply.disabled = true;
      if (reasonText) {
        reasonText.textContent = (solution && solution.reason) || "No consensus reached between models.";
      }
      return;
    }

    const qType = (solution.q_type || (extracted && extracted.q_type) || "mcq").toLowerCase();

    // 1. Badge Display
    if (badgeOpt) {
      badgeOpt.className = "hud-badge-option";
      if (qType === "order") {
        badgeOpt.classList.add("order");
        badgeOpt.textContent = "ORD";
      } else if (qType === "text") {
        badgeOpt.classList.add("text");
        badgeOpt.textContent = "TXT";
      } else {
        const letter = solution.canonical_key || solution.letter ||
          (typeof solution.selected_index === "number" ? String.fromCharCode(65 + solution.selected_index) : "A");
        badgeOpt.textContent = `[${letter}]`;
      }
      badgeOpt.classList.remove("hidden");
    }

    // 2. Answer Text Display
    if (answerText) {
      answerText.className = "hud-answer-text";
      let displayText = "";
      if (qType === "order") {
        displayText = (solution.ordered_texts && solution.ordered_texts.length)
          ? solution.ordered_texts.join(" ➔ ")
          : (solution.answer || "Ordered sequence ready");
      } else {
        displayText = solution.selected_text || solution.selected_option || solution.answer || "Answer ready";
      }
      answerText.textContent = displayText;
      answerText.title = displayText;
    }

    // 3. Confidence Tag
    if (tagConf) {
      const tier = (solution.confidence_tier || "").toUpperCase();
      const label = (solution.confidence_label || "").toLowerCase();
      if (tier.includes("HIGH") || label === "high" || solution.agreement_status === "both_agree") {
        tagConf.className = "hud-pill-tag hud-tag-high";
        tagConf.textContent = "HIGH";
        tagConf.classList.remove("hidden");
      } else if (tier.includes("MEDIUM") || label === "medium" || solution.agreement_status === "tiebreaker_agree") {
        tagConf.className = "hud-pill-tag hud-tag-med";
        tagConf.textContent = "MED";
        tagConf.classList.remove("hidden");
      } else {
        tagConf.classList.add("hidden");
      }
    }

    // 4. Cache & Latency Tags
    if (tagCache) {
      if (solution.cache_hit) {
        tagCache.classList.remove("hidden");
      } else {
        tagCache.classList.add("hidden");
      }
    }

    if (tagLatency && typeof solution.latency_ms === "number") {
      tagLatency.textContent = `${Math.round(solution.latency_ms)}ms`;
      tagLatency.classList.remove("hidden");
    }

    // 5. Enable Apply Button
    if (btnApply) {
      btnApply.disabled = false;
    }

    // 6. Update Drawer Reasoning
    if (reasonText) {
      reasonText.textContent = solution.reason || "Derivation verified step-by-step.";
    }
  }

  // ==========================================================================
  // Core Extraction, Solve & Execution Routines
  // ==========================================================================
  function extractCurrentQuiz() {
    if (window.__QuizZyExtractor && typeof window.__QuizZyExtractor.extractQuizFromDom === "function") {
      try {
        return window.__QuizZyExtractor.extractQuizFromDom(document);
      } catch (err) {
        console.error("[QuizZy HUD] Extraction error:", err);
      }
    }
    return null;
  }

  function solveCurrentQuestion(callback) {
    if (isSolving) return;
    const extracted = extractCurrentQuiz();

    if (!extracted || !extracted.success) {
      if (answerText) {
        answerText.className = "hud-answer-text uncertain";
        answerText.textContent = "No quiz question found on page";
      }
      if (callback) callback(null, extracted);
      return;
    }

    setSolvingState();

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

  function buildExecuteActionPayload(solveData, extracted) {
    if (!solveData) return null;
    const qType = (extracted && extracted.q_type) || (solveData.q_type || "mcq").toLowerCase();
    const options = (extracted && Array.isArray(extracted.options)) ? extracted.options : [];

    // Resolve targetIndex (0-based integer)
    let targetIndex = null;
    if (typeof solveData.selected_index === "number" && solveData.selected_index >= 0 && (options.length === 0 || solveData.selected_index < options.length)) {
      targetIndex = solveData.selected_index;
    } else if (typeof solveData.canonical_key === "string" && /^[A-F]$/i.test(solveData.canonical_key.trim())) {
      targetIndex = solveData.canonical_key.trim().toUpperCase().charCodeAt(0) - 65;
    } else if (typeof solveData.answer === "string" && /^[A-F]$/i.test(solveData.answer.trim())) {
      targetIndex = solveData.answer.trim().toUpperCase().charCodeAt(0) - 65;
    } else if (typeof solveData.letter === "string" && /^[A-F]$/i.test(solveData.letter.trim())) {
      targetIndex = solveData.letter.trim().toUpperCase().charCodeAt(0) - 65;
    } else if (options.length > 0) {
      const matchText = solveData.selected_text || solveData.selected_option || solveData.answer;
      if (matchText) {
        const cleanMatch = String(matchText).trim().toLowerCase();
        const foundIdx = options.findIndex(opt => opt && String(opt).trim().toLowerCase() === cleanMatch);
        if (foundIdx !== -1) {
          targetIndex = foundIdx;
        }
      }
    }

    // Resolve targetText
    let targetText = "";
    if (targetIndex !== null && targetIndex >= 0 && targetIndex < options.length) {
      targetText = options[targetIndex];
    } else {
      targetText = solveData.selected_text || solveData.selected_option || solveData.answer || "";
    }

    const letter = (targetIndex !== null && targetIndex >= 0) ? String.fromCharCode(65 + targetIndex) : "";

    return {
      question_type: qType,
      q_type: qType,
      targetIndex,
      selected_index: targetIndex,
      targetText,
      selected_text: targetText,
      answer: (qType === "mcq" && targetText) ? targetText : solveData.answer,
      letter,
      ordered_indices: solveData.ordered_indices,
      ordered_texts: solveData.ordered_texts,
      target_permutation: solveData.ordered_indices,
      permutation_indices: solveData.permutation_indices
    };
  }

  function applyCurrentSolution(callback) {
    if (!latestSolution || latestSolution.status !== "ok") {
      if (callback) callback({ success: false, reason: "No valid solution to apply" });
      return;
    }

    const actionPayload = buildExecuteActionPayload(latestSolution, latestExtracted);
    if (!actionPayload) {
      if (callback) callback({ success: false, reason: "Could not build action payload" });
      return;
    }

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
      if (miniDot) miniDot.classList.add("auto-running");
    } else {
      btnAuto.className = "hud-btn hud-btn-auto";
      if (autoLabel) autoLabel.textContent = "Auto";
      if (autoIcon) {
        autoIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3" fill="currentColor"></polygon>';
      }
      if (miniDot) miniDot.classList.remove("auto-running");
    }
  }

  function startAutoMode() {
    isAutoRunning = true;
    autoStepCount = 0;
    autoRetryCount = 0;
    updateAutoButtonState(true);

    // Auto-allowlist current host
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
    autoRetryCount = 0;
    updateAutoButtonState(false);
    if (message && answerText) {
      if (message.includes("Completed")) {
        answerText.className = "hud-answer-text complete";
      } else {
        answerText.className = "hud-answer-text ready";
      }
      answerText.textContent = message;
      answerText.title = message;
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

      const isStrict = chkStrict && chkStrict.checked;
      const hasValidSelection = solution && (
        (typeof solution.selected_index === "number" && solution.selected_index >= 0) ||
        (solution.answer && typeof solution.answer === "string" && solution.answer.trim().length > 0) ||
        (solution.canonical_key && typeof solution.canonical_key === "string" && solution.canonical_key.trim().length > 0) ||
        (solution.selected_text && typeof solution.selected_text === "string" && solution.selected_text.trim().length > 0)
      );

      if (!hasValidSelection) {
        if (autoRetryCount < 1) {
          autoRetryCount++;
          setTimeout(runAutoStep, 350);
          return;
        }
        stopAutoMode(isStrict ? "Model consensus uncertain (Strict Mode). Auto Mode stopped." : "No answer available. Auto Mode stopped.");
        return;
      }

      autoRetryCount = 0;

      // Check strict HIGH agreement constraint
      if (isStrict) {
        const isHigh = solution.confidence_label === "high" ||
          solution.agreement_status === "both_agree" ||
          (solution.confidence_tier && solution.confidence_tier.includes("HIGH"));
        if (!isHigh) {
          stopAutoMode("Model consensus uncertain. Auto Mode stopped.");
          return;
        }
      }

      const prevSig = getQuestionSig(extracted);

      // Apply answer once
      applyCurrentSolution((applyRes) => {
        if (!isAutoRunning) return;

        // Brief delay before clicking Submit / Next so React state commits
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
        }, 220);
      });
    });
  }

  // ==========================================================================
  // UI Interactions (Buttons, Drawer, Minimize, Visibility)
  // ==========================================================================
  function setMinimized(minimized) {
    isMinimizedState = Boolean(minimized);
    storage.set({ quizzy_hud_minimized: isMinimizedState });

    if (isMinimizedState) {
      if (fullBar) fullBar.classList.add("hidden");
      if (popover) popover.classList.add("hidden");
      if (miniDot) {
        miniDot.classList.remove("hidden");
        if (isAutoRunning) {
          miniDot.classList.add("auto-running");
        } else {
          miniDot.classList.remove("auto-running");
        }
      }
      storage.get(["quizzy_dot_pos"], (res) => {
        if (res.quizzy_dot_pos && typeof res.quizzy_dot_pos.left === "number") {
          applyDotPosition(res.quizzy_dot_pos);
        } else {
          const defaultDotX = Math.max(8, window.innerWidth - 34);
          const defaultDotY = Math.max(8, window.innerHeight - 34);
          wrapper.style.left = `${defaultDotX}px`;
          wrapper.style.top = `${defaultDotY}px`;
        }
      });
    } else {
      if (miniDot) miniDot.classList.add("hidden");
      if (fullBar) fullBar.classList.remove("hidden");
      storage.get(["quizzy_hud_pos"], (res) => {
        applyBarPosition(res.quizzy_hud_pos);
      });
    }
  }

  function setHidden(hidden) {
    isHiddenState = Boolean(hidden);
    if (isHiddenState) {
      if (isAutoRunning) {
        stopAutoMode("Stopped: HUD hidden");
      }
      wrapper.classList.add("hidden");
    } else {
      wrapper.classList.remove("hidden");
      checkHealth();
    }
  }

  function toggleVisibility() {
    setHidden(!isHiddenState);
    return !isHiddenState;
  }

  function show() {
    setHidden(false);
  }

  function hide() {
    setHidden(true);
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
  // Double-Tap Hotkeys (Ctrl, Z / Alt, Fn / Shift)
  // ==========================================================================
  let ctrlDown = false;
  let ctrlComboUsed = false;
  let altDown = false;
  let altComboUsed = false;
  let shiftDown = false;
  let shiftComboUsed = false;
  let fnDown = false;
  let fnComboUsed = false;
  let zDown = false;
  let zComboUsed = false;

  const lastTapTimes = {
    Control: 0,
    Alt: 0,
    Shift: 0,
    Fn: 0,
    Z: 0
  };

  function isEditableElement(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    if (typeof el.getAttribute === "function" && el.getAttribute("contenteditable") === "true") return true;
    return false;
  }

  function isFnKey(e) {
    return e.key === "Fn" || e.key === "Function" || e.code === "Fn" || e.key === "Unidentified" || e.keyCode === 255;
  }

  function handleModifierDoubleTap(modName, e) {
    const now = Date.now();
    const last = lastTapTimes[modName] || 0;
    const diff = now - last;

    if (last > 0 && diff >= 0 && diff <= 420) {
      lastTapTimes[modName] = 0;
      if (modName === "Control") {
        if (!isHiddenState && isVisibleState) {
          if (isAutoRunning) {
            stopAutoMode("Stopped via Ctrl hotkey");
          }
          setHidden(true);
        } else {
          setHidden(false);
        }
      } else if (modName === "Alt" || modName === "Z") {
        if (e && typeof e.preventDefault === "function") {
          e.preventDefault();
        }
        if (isHiddenState) {
          setHidden(false);
        }
        setMinimized(!isMinimizedState);
      } else if (modName === "Fn" || modName === "Shift") {
        if (isAutoRunning) {
          stopAutoMode("Stopped via hotkey");
        } else {
          if (isHiddenState) {
            setHidden(false);
          }
          startAutoMode();
        }
      }
    } else {
      lastTapTimes[modName] = now;
    }
  }

  function onGlobalKeyDown(e) {
    if (e.key === "Escape" || e.key === "Esc") {
      if (isAutoRunning) {
        stopAutoMode("Escape key pressed.");
        if (typeof e.preventDefault === "function") e.preventDefault();
        return;
      }
    }

    if (e.altKey && (e.key === "s" || e.key === "S")) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      solveCurrentQuestion();
      return;
    }
    if (e.altKey && (e.key === "a" || e.key === "A")) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      applyCurrentSolution();
      return;
    }

    if (e.repeat) return;

    if (e.key === "Control") {
      ctrlDown = true;
      ctrlComboUsed = false;
    } else if (e.key === "Alt") {
      altDown = true;
      altComboUsed = false;
    } else if (e.key === "Shift") {
      shiftDown = true;
      shiftComboUsed = false;
    } else if (isFnKey(e)) {
      fnDown = true;
      fnComboUsed = false;
      handleModifierDoubleTap("Fn", e);
    } else if (e.key === "z" || e.key === "Z" || e.code === "KeyZ") {
      const activeEl = (typeof document !== "undefined") ? document.activeElement : null;
      if (!isEditableElement(e.target) && !isEditableElement(activeEl) && !e.ctrlKey && !e.altKey && !e.metaKey && !ctrlDown && !altDown) {
        zDown = true;
        zComboUsed = false;
      } else {
        zDown = false;
        zComboUsed = true;
      }
    } else {
      if (ctrlDown) ctrlComboUsed = true;
      if (altDown) altComboUsed = true;
      if (shiftDown) shiftComboUsed = true;
      if (fnDown) fnComboUsed = true;
      if (zDown) zComboUsed = true;
    }
  }

  function onGlobalKeyUp(e) {
    if (e.key === "Control") {
      ctrlDown = false;
      if (!ctrlComboUsed) {
        handleModifierDoubleTap("Control", e);
      }
    } else if (e.key === "Alt") {
      altDown = false;
      if (!altComboUsed) {
        handleModifierDoubleTap("Alt", e);
      }
    } else if (e.key === "Shift") {
      shiftDown = false;
      if (!shiftComboUsed) {
        handleModifierDoubleTap("Shift", e);
      }
    } else if (isFnKey(e)) {
      fnDown = false;
      if (!fnComboUsed) {
        handleModifierDoubleTap("Fn", e);
      }
    } else if (e.key === "z" || e.key === "Z" || e.code === "KeyZ") {
      if (zDown && !zComboUsed) {
        handleModifierDoubleTap("Z", e);
      }
      zDown = false;
      zComboUsed = false;
    }
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("keydown", onGlobalKeyDown, true);
    window.addEventListener("keyup", onGlobalKeyUp, true);
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
    fullBar,
    miniDot,
    isVisible: () => isVisibleState && !isHiddenState,
    isHidden: () => isHiddenState,
    isMinimized: () => isMinimizedState,
    toggle: toggleVisibility,
    show,
    hide,
    setMinimized,
    setHidden,
    solve: solveCurrentQuestion,
    apply: applyCurrentSolution,
    startAuto: startAutoMode,
    stopAuto: stopAutoMode,
    destroy: () => {
      clearInterval(healthInterval);
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("keydown", onGlobalKeyDown, true);
        window.removeEventListener("keyup", onGlobalKeyUp, true);
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
    visible: isVisibleState && !isHiddenState,
    instance: hudInstance,
    shadow,
    wrapper,
    fullBar,
    miniDot,
    ...hudInstance
  };
})();
