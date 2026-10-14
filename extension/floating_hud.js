/**
 * QuizZy - Sleek, Draggable, Shadow-DOM Isolated Floating HUD Bar
 * 
 * Injected on-demand into the active quiz tab inside a Shadow Root.
 * Fully isolated from host page CSS, scripts, and quiz extraction logic.
 */

(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") {
    // Graceful fallback for non-browser / unit-test environments
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

  // Idempotency: If instance already exists, toggle visibility / bring to front
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

  // Check if host element already exists in document
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-quizzy-ignore", "true");
    host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; pointer-events: none; overflow: visible;";
    
    // Mount to document.documentElement or document.body
    if (document.documentElement) {
      document.documentElement.appendChild(host);
    } else if (document.body) {
      document.body.appendChild(host);
    }
  }

  // Attach Open Shadow Root (or reuse existing if attached)
  let shadow = host.shadowRoot;
  if (!shadow) {
    try {
      shadow = host.attachShadow({ mode: "open" });
    } catch (e) {
      // In case host already has a shadow root
      shadow = host.shadowRoot || host;
    }
  }

  // ==========================================================================
  // HUD Scoped CSS Styles (Dark Mode, Glassmorphic, Modern Typography)
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
      filter: drop-shadow(0 16px 36px rgba(0, 0, 0, 0.65)) drop-shadow(0 2px 8px rgba(0, 0, 0, 0.4));
      transition: opacity 160ms cubic-bezier(0.16, 1, 0.3, 1), transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .quizzy-hud-wrapper.hidden {
      display: none !important;
    }

    /* Full Floating Bar Container */
    .hud-bar {
      display: flex;
      flex-direction: column;
      min-width: 580px;
      max-width: 720px;
      background: rgba(11, 15, 25, 0.94);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 14px;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.05), 0 8px 30px rgba(0, 0, 0, 0.5);
      color: #F8FAFC;
      font-size: 13px;
      overflow: hidden;
    }

    /* Top Compact Row (~48px) */
    .hud-top-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 12px;
      min-height: 48px;
    }

    /* Drag Handle */
    .hud-drag-handle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 32px;
      cursor: grab;
      color: #64748B;
      border-radius: 6px;
      transition: background 150ms, color 150ms;
      touch-action: none;
      flex-shrink: 0;
    }

    .hud-drag-handle:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #94A3B8;
    }

    .hud-drag-handle:active {
      cursor: grabbing;
      color: #38BDF8;
    }

    .hud-drag-icon {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }

    /* Brand Logo & Health Dot */
    .hud-brand {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      font-size: 13.5px;
      letter-spacing: -0.2px;
      color: #F8FAFC;
      flex-shrink: 0;
    }

    .hud-brand-logo {
      width: 16px;
      height: 16px;
      color: #38BDF8;
    }

    .hud-health-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #EF4444;
      box-shadow: 0 0 6px #EF4444;
      transition: background 250ms, box-shadow 250ms;
      flex-shrink: 0;
    }

    .hud-health-dot.online {
      background: #10B981;
      box-shadow: 0 0 6px #10B981;
    }

    .hud-divider {
      width: 1px;
      height: 22px;
      background: rgba(255, 255, 255, 0.12);
      flex-shrink: 0;
    }

    /* Answer Display Pill */
    .hud-answer-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 5px 10px;
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }

    .hud-pill-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #0284C7;
      color: #FFFFFF;
      font-weight: 700;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 5px;
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }

    .hud-pill-badge.uncertain {
      background: #EF4444;
    }

    .hud-pill-text {
      color: #E2E8F0;
      font-size: 12.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }

    .hud-pill-text.ready {
      color: #94A3B8;
      font-style: italic;
    }

    .hud-pill-text.solving {
      color: #38BDF8;
      font-weight: 600;
      animation: hud-pulse 1.4s infinite ease-in-out;
    }

    @keyframes hud-pulse {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; }
    }

    .hud-meta-badge {
      display: inline-flex;
      align-items: center;
      font-size: 10.5px;
      font-weight: 600;
      padding: 2px 5px;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .hud-badge-high {
      background: rgba(16, 185, 129, 0.2);
      color: #34D399;
      border: 1px solid rgba(16, 185, 129, 0.35);
    }

    .hud-badge-med {
      background: rgba(245, 158, 11, 0.2);
      color: #FBBF24;
      border: 1px solid rgba(245, 158, 11, 0.35);
    }

    .hud-badge-cache {
      background: rgba(6, 182, 212, 0.2);
      color: #22D3EE;
      border: 1px solid rgba(6, 182, 212, 0.35);
    }

    .hud-badge-latency {
      color: #64748B;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10px;
    }

    /* Action Buttons */
    .hud-actions {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
    }

    .hud-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 6px 10px;
      border-radius: 7px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 140ms ease;
      outline: none;
      white-space: nowrap;
      height: 32px;
    }

    .hud-btn:focus-visible {
      box-shadow: 0 0 0 2px #38BDF8;
    }

    .hud-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .hud-btn-primary {
      background: #0284C7;
      color: #FFFFFF;
      border-color: rgba(255, 255, 255, 0.15);
    }

    .hud-btn-primary:hover:not(:disabled) {
      background: #0369A1;
      transform: translateY(-1px);
    }

    .hud-btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #F1F5F9;
      border-color: rgba(255, 255, 255, 0.12);
    }

    .hud-btn-secondary:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.14);
      color: #FFFFFF;
    }

    .hud-btn-auto {
      background: rgba(16, 185, 129, 0.15);
      color: #34D399;
      border-color: rgba(16, 185, 129, 0.35);
    }

    .hud-btn-auto:hover:not(:disabled) {
      background: rgba(16, 185, 129, 0.25);
    }

    .hud-btn-auto.running {
      background: rgba(239, 68, 68, 0.2);
      color: #F87171;
      border-color: rgba(239, 68, 68, 0.45);
      animation: hud-auto-pulse 1.2s infinite alternate;
    }

    @keyframes hud-auto-pulse {
      from { border-color: rgba(239, 68, 68, 0.4); }
      to { border-color: rgba(239, 68, 68, 0.9); }
    }

    .hud-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: transparent;
      border: 1px solid transparent;
      color: #94A3B8;
      cursor: pointer;
      transition: background 140ms, color 140ms;
      outline: none;
    }

    .hud-icon-btn:hover {
      background: rgba(255, 255, 255, 0.09);
      color: #F8FAFC;
    }

    .hud-icon-btn:focus-visible {
      box-shadow: 0 0 0 2px #38BDF8;
    }

    /* Expandable Drawer */
    .hud-drawer {
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding: 12px 14px;
      background: rgba(15, 23, 42, 0.96);
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 280px;
      overflow-y: auto;
    }

    .hud-drawer.hidden {
      display: none !important;
    }

    .hud-drawer-section {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .hud-drawer-label {
      font-size: 11px;
      font-weight: 700;
      color: #64748B;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .hud-drawer-question {
      font-size: 12px;
      color: #CBD5E1;
      line-height: 1.45;
      background: rgba(0, 0, 0, 0.25);
      padding: 6px 9px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .hud-drawer-reason {
      font-size: 12px;
      color: #94A3B8;
      line-height: 1.45;
      font-style: italic;
    }

    .hud-drawer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-top: 4px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }

    .hud-btn-flag {
      background: rgba(239, 68, 68, 0.12);
      color: #FCA5A5;
      border: 1px solid rgba(239, 68, 68, 0.3);
      padding: 4px 8px;
      font-size: 11px;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-weight: 600;
      transition: all 140ms;
    }

    .hud-btn-flag:hover {
      background: rgba(239, 68, 68, 0.24);
      color: #FFFFFF;
    }

    .hud-btn-flag.flagged {
      background: rgba(16, 185, 129, 0.2);
      color: #34D399;
      border-color: rgba(16, 185, 129, 0.4);
      cursor: default;
    }

    /* Minimized Floating Pill */
    .hud-minimized-pill {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 12px;
      background: rgba(11, 15, 25, 0.94);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 999px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      color: #F8FAFC;
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 140ms ease, background 140ms ease;
    }

    .hud-minimized-pill:hover {
      transform: scale(1.04);
      background: rgba(15, 23, 42, 0.98);
      border-color: #38BDF8;
    }

    .hud-minimized-pill.hidden {
      display: none !important;
    }

    /* SVG icon utility */
    .hud-svg {
      width: 14px;
      height: 14px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
  `;

  // Insert styles into shadow DOM
  const styleEl = document.createElement("style");
  styleEl.textContent = HUD_STYLES;
  shadow.appendChild(styleEl);

  // ==========================================================================
  // HUD HTML Markup
  // ==========================================================================
  const wrapper = document.createElement("div");
  wrapper.className = "quizzy-hud-wrapper";
  wrapper.innerHTML = `
    <!-- Minimized Floating Pill Mode -->
    <div class="hud-minimized-pill hidden" id="hud-minimized-pill" title="Click to expand QuizZy HUD">
      <span class="hud-health-dot" id="hud-min-health-dot"></span>
      <svg class="hud-svg" viewBox="0 0 24 24" style="color: #38BDF8;">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"></polygon>
      </svg>
      <span>QuizZy</span>
      <span style="font-size: 11px; opacity: 0.6;">↗</span>
    </div>

    <!-- Full Floating Bar -->
    <div class="hud-bar" id="hud-full-bar">
      <!-- Top Compact Row (~48px) -->
      <div class="hud-top-row">
        <!-- Drag Handle -->
        <div class="hud-drag-handle" id="hud-drag-handle" title="Drag to move bar">
          <svg class="hud-drag-icon" viewBox="0 0 24 24">
            <circle cx="9" cy="5" r="1.5"></circle>
            <circle cx="9" cy="12" r="1.5"></circle>
            <circle cx="9" cy="19" r="1.5"></circle>
            <circle cx="15" cy="5" r="1.5"></circle>
            <circle cx="15" cy="12" r="1.5"></circle>
            <circle cx="15" cy="19" r="1.5"></circle>
          </svg>
        </div>

        <!-- Brand & Health Dot -->
        <div class="hud-brand" title="QuizZy HUD Bar">
          <svg class="hud-brand-logo" viewBox="0 0 24 24">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"></polygon>
          </svg>
          <span>QuizZy</span>
          <span class="hud-health-dot" id="hud-health-dot" title="Backend: Offline"></span>
        </div>

        <div class="hud-divider"></div>

        <!-- Answer Display Pill -->
        <div class="hud-answer-pill" id="hud-answer-pill">
          <span class="hud-pill-badge" id="hud-pill-badge">[Ready]</span>
          <span class="hud-pill-text ready" id="hud-pill-text">Press Solve (Alt+S)</span>
          <span class="hud-meta-badge hud-badge-high hidden" id="hud-badge-confidence">HIGH</span>
          <span class="hud-meta-badge hud-badge-cache hidden" id="hud-badge-cache">CACHE</span>
          <span class="hud-meta-badge hud-badge-latency hidden" id="hud-badge-latency">0ms</span>
        </div>

        <!-- Action Buttons -->
        <div class="hud-actions">
          <button class="hud-btn hud-btn-primary" id="hud-btn-solve" title="Extract current question and solve (Alt+S)">
            <svg class="hud-svg" viewBox="0 0 24 24">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor"></polygon>
            </svg>
            <span>Solve</span>
          </button>

          <button class="hud-btn hud-btn-secondary" id="hud-btn-apply" title="Apply winning answer to page (Alt+A)" disabled>
            <svg class="hud-svg" viewBox="0 0 24 24">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span>Apply</span>
          </button>

          <button class="hud-btn hud-btn-auto" id="hud-btn-auto" title="Run guarded Auto Mode (Halt with Escape)">
            <svg class="hud-svg" id="hud-auto-icon" viewBox="0 0 24 24">
              <polygon points="5 3 19 12 5 21 5 3" fill="currentColor"></polygon>
            </svg>
            <span id="hud-auto-label">Auto</span>
          </button>

          <button class="hud-icon-btn" id="hud-btn-info" title="Toggle Answer Reasoning Drawer">
            <svg class="hud-svg" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="16" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12.01" y2="8"></line>
            </svg>
          </button>

          <button class="hud-icon-btn" id="hud-btn-minimize" title="Minimize bar into floating pill">
            <svg class="hud-svg" viewBox="0 0 24 24">
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>

          <button class="hud-icon-btn" id="hud-btn-close" title="Close Floating HUD">
            <svg class="hud-svg" viewBox="0 0 24 24">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>

      <!-- Expandable Drawer below bar -->
      <div class="hud-drawer hidden" id="hud-drawer">
        <div class="hud-drawer-section">
          <span class="hud-drawer-label">Question Stem</span>
          <div class="hud-drawer-question" id="hud-drawer-question">No question extracted yet.</div>
        </div>

        <div class="hud-drawer-section">
          <span class="hud-drawer-label">Reasoning & Verification</span>
          <div class="hud-drawer-reason" id="hud-drawer-reason">Awaiting solution...</div>
        </div>

        <div class="hud-drawer-footer">
          <div style="font-size: 11px; color: #64748B;" id="hud-drawer-status">
            Model: Consensus Dual-Model
          </div>
          <button class="hud-btn-flag" id="hud-btn-flag" title="Flag answer as incorrect and evict from cache">
            <span>🚩 Flag Wrong</span>
          </button>
        </div>
      </div>
    </div>
  `;

  shadow.appendChild(wrapper);

  // ==========================================================================
  // References to Internal Shadow DOM Elements
  // ==========================================================================
  const fullBar = wrapper.querySelector("#hud-full-bar");
  const minimizedPill = wrapper.querySelector("#hud-minimized-pill");
  const dragHandle = wrapper.querySelector("#hud-drag-handle");
  const healthDot = wrapper.querySelector("#hud-health-dot");
  const minHealthDot = wrapper.querySelector("#hud-min-health-dot");
  const pillBadge = wrapper.querySelector("#hud-pill-badge");
  const pillText = wrapper.querySelector("#hud-pill-text");
  const badgeConfidence = wrapper.querySelector("#hud-badge-confidence");
  const badgeCache = wrapper.querySelector("#hud-badge-cache");
  const badgeLatency = wrapper.querySelector("#hud-badge-latency");
  const btnSolve = wrapper.querySelector("#hud-btn-solve");
  const btnApply = wrapper.querySelector("#hud-btn-apply");
  const btnAuto = wrapper.querySelector("#hud-btn-auto");
  const autoLabel = wrapper.querySelector("#hud-auto-label");
  const autoIcon = wrapper.querySelector("#hud-auto-icon");
  const btnInfo = wrapper.querySelector("#hud-btn-info");
  const btnMinimize = wrapper.querySelector("#hud-btn-minimize");
  const btnClose = wrapper.querySelector("#hud-btn-close");
  const drawer = wrapper.querySelector("#hud-drawer");
  const drawerQuestion = wrapper.querySelector("#hud-drawer-question");
  const drawerReason = wrapper.querySelector("#hud-drawer-reason");
  const drawerStatus = wrapper.querySelector("#hud-drawer-status");
  const btnFlag = wrapper.querySelector("#hud-btn-flag");

  // ==========================================================================
  // HUD State Management
  // ==========================================================================
  let isVisibleState = true;
  let isMinimizedState = false;
  let isDrawerOpen = false;
  let isAutoRunning = false;
  let isSolving = false;
  let latestExtracted = null;
  let latestSolution = null;

  // Storage helper for Chrome extension vs mock
  const storage = (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) ? chrome.storage.local : {
    get: (keys, cb) => {
      try {
        const res = {};
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) {
          const val = localStorage.getItem(k);
          if (val) res[k] = JSON.parse(val);
        }
        cb(res);
      } catch (_) { cb({}); }
    },
    set: (items, cb) => {
      try {
        for (const [k, v] of Object.entries(items)) {
          localStorage.setItem(k, JSON.stringify(v));
        }
      } catch (_) {}
      if (cb) cb();
    }
  };

  // Safe messaging to extension background
  function sendExtensionMessage(msg, callback) {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          if (callback) callback({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        if (callback) callback(res || { success: true });
      });
    } else {
      if (callback) callback({ success: false, error: "chrome.runtime unavailable" });
    }
  }

  // ==========================================================================
  // Draggable Position & Clamping
  // ==========================================================================
  function clampPosition(left, top) {
    const rect = wrapper.getBoundingClientRect();
    const w = rect.width || 600;
    const h = rect.height || 48;
    const maxLeft = Math.max(0, window.innerWidth - w - 8);
    const maxTop = Math.max(0, window.innerHeight - h - 8);
    return {
      left: Math.max(8, Math.min(left, maxLeft)),
      top: Math.max(8, Math.min(top, maxTop))
    };
  }

  function setHudPosition(left, top) {
    const pos = clampPosition(left, top);
    wrapper.style.left = `${pos.left}px`;
    wrapper.style.top = `${pos.top}px`;
    wrapper.style.right = "auto";
    wrapper.style.bottom = "auto";
  }

  // Restore saved position or default to bottom-right
  storage.get(["quizzy_hud_pos", "quizzy_hud_minimized"], (res) => {
    if (res && res.quizzy_hud_minimized) {
      setMinimized(true);
    }
    if (res && res.quizzy_hud_pos && typeof res.quizzy_hud_pos.left === "number" && typeof res.quizzy_hud_pos.top === "number") {
      setHudPosition(res.quizzy_hud_pos.left, res.quizzy_hud_pos.top);
    } else {
      // Default: bottom-right with 24px margins
      const defaultLeft = Math.max(16, window.innerWidth - 640 - 24);
      const defaultTop = Math.max(16, window.innerHeight - 60 - 24);
      setHudPosition(defaultLeft, defaultTop);
    }
  });

  // Dragging event listeners on header / drag-handle
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  function onDragStart(e) {
    // Only accept left mouse button or touch
    if (e.type === "mousedown" && e.button !== 0) return;
    
    isDragging = true;
    const clientX = e.type.startsWith("touch") ? e.touches[0].clientX : e.clientX;
    const clientY = e.type.startsWith("touch") ? e.touches[0].clientY : e.clientY;
    dragStartX = clientX;
    dragStartY = clientY;

    const rect = wrapper.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("mousemove", onDragMove, { passive: false });
      window.addEventListener("mouseup", onDragEnd);
      window.addEventListener("touchmove", onDragMove, { passive: false });
      window.addEventListener("touchend", onDragEnd);
    }
    e.preventDefault();
  }

  function onDragMove(e) {
    if (!isDragging) return;
    const clientX = e.type.startsWith("touch") ? e.touches[0].clientX : e.clientX;
    const clientY = e.type.startsWith("touch") ? e.touches[0].clientY : e.clientY;
    const deltaX = clientX - dragStartX;
    const deltaY = clientY - dragStartY;

    setHudPosition(initialLeft + deltaX, initialTop + deltaY);
    e.preventDefault();
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragEnd);
      window.removeEventListener("touchmove", onDragMove);
      window.removeEventListener("touchend", onDragEnd);
    }

    const rect = wrapper.getBoundingClientRect();
    storage.set({ quizzy_hud_pos: { left: rect.left, top: rect.top } });
  }

  if (dragHandle) {
    dragHandle.addEventListener("mousedown", onDragStart);
    dragHandle.addEventListener("touchstart", onDragStart, { passive: false });
  }
  if (minimizedPill) {
    minimizedPill.addEventListener("mousedown", onDragStart);
    minimizedPill.addEventListener("touchstart", onDragStart, { passive: false });
  }

  // ==========================================================================
  // Health Check Poller
  // ==========================================================================
  function updateBackendHealth() {
    sendExtensionMessage({ action: "CHECK_HEALTH" }, (res) => {
      const isOnline = res && res.success && res.data;
      if (isOnline) {
        if (healthDot) {
          healthDot.className = "hud-health-dot online";
          healthDot.title = `Backend Connected (Cache: ${res.data.cache_entries || 0})`;
        }
        if (minHealthDot) {
          minHealthDot.className = "hud-health-dot online";
        }
      } else {
        if (healthDot) {
          healthDot.className = "hud-health-dot";
          healthDot.title = "Backend Offline (Run uvicorn backend.app:app)";
        }
        if (minHealthDot) {
          minHealthDot.className = "hud-health-dot";
        }
      }
    });
  }

  updateBackendHealth();
  const healthInterval = setInterval(updateBackendHealth, 7000);
  if (healthInterval && typeof healthInterval.unref === "function") {
    healthInterval.unref();
  }

  // ==========================================================================
  // Display Helpers
  // ==========================================================================
  function setSolvingState() {
    isSolving = true;
    if (pillBadge) {
      pillBadge.className = "hud-pill-badge";
      pillBadge.textContent = "Solving";
    }
    if (pillText) {
      pillText.className = "hud-pill-text solving";
      pillText.textContent = "Analyzing question & querying dual models...";
    }
    if (badgeConfidence) badgeConfidence.classList.add("hidden");
    if (badgeCache) badgeCache.classList.add("hidden");
    if (badgeLatency) badgeLatency.classList.add("hidden");
    if (btnApply) btnApply.disabled = true;
  }

  function renderSolution(solution, extracted) {
    isSolving = false;
    latestSolution = solution;
    latestExtracted = extracted;

    if (!solution || solution.status !== "ok") {
      if (pillBadge) {
        pillBadge.className = "hud-pill-badge uncertain";
        pillBadge.textContent = "Uncertain";
      }
      if (pillText) {
        pillText.className = "hud-pill-text";
        pillText.textContent = solution && solution.reason ? solution.reason : "Model consensus uncertain";
      }
      if (badgeConfidence) badgeConfidence.classList.add("hidden");
      if (badgeCache) badgeCache.classList.add("hidden");
      if (badgeLatency) badgeLatency.classList.add("hidden");
      if (btnApply) btnApply.disabled = true;
      if (drawerQuestion) drawerQuestion.textContent = extracted ? extracted.question : "N/A";
      if (drawerReason) drawerReason.textContent = solution ? (solution.reason || "Uncertain consensus") : "No solution returned";
      return;
    }

    // Set Option Badge & Winner Text
    let badgeLabel = "[A]";
    let winText = "";

    if (solution.q_type === "mcq") {
      badgeLabel = `[${solution.answer || "A"}]`;
      winText = solution.selected_text || (extracted?.options?.[solution.selected_index]) || "Option";
    } else if (solution.q_type === "order") {
      badgeLabel = "[Order]";
      winText = Array.isArray(solution.ordered_texts) ? solution.ordered_texts.join(" ➔ ") : (solution.answer || "Sequence");
    } else if (solution.q_type === "text") {
      badgeLabel = "[Text]";
      winText = solution.answer || "Answer";
    }

    if (pillBadge) {
      pillBadge.className = "hud-pill-badge";
      pillBadge.textContent = badgeLabel;
    }
    if (pillText) {
      pillText.className = "hud-pill-text";
      pillText.textContent = winText;
      pillText.title = winText;
    }

    // Confidence badge
    if (badgeConfidence) {
      const conf = (solution.confidence_label || "high").toLowerCase();
      badgeConfidence.classList.remove("hidden", "hud-badge-high", "hud-badge-med");
      if (conf === "high") {
        badgeConfidence.classList.add("hud-badge-high");
        badgeConfidence.textContent = "HIGH";
      } else {
        badgeConfidence.classList.add("hud-badge-med");
        badgeConfidence.textContent = "MED";
      }
    }

    // Cache badge
    if (badgeCache) {
      if (solution.cache_hit) {
        badgeCache.classList.remove("hidden");
      } else {
        badgeCache.classList.add("hidden");
      }
    }

    // Latency badge
    if (badgeLatency) {
      badgeLatency.classList.remove("hidden");
      badgeLatency.textContent = `${Math.round(solution.latency_ms || 0)}ms`;
    }

    // Enable Apply button
    if (btnApply) {
      btnApply.disabled = false;
    }

    // Populate drawer content
    if (drawerQuestion && extracted) {
      drawerQuestion.textContent = extracted.question || "N/A";
    }
    if (drawerReason) {
      drawerReason.textContent = solution.reason || "Model consensus agreement verified.";
    }
    if (drawerStatus) {
      const src = solution.sources_used && solution.sources_used.length > 0 ? `Web Verified (${solution.sources_used.length} sources)` : "Dual-Model Agreement";
      drawerStatus.textContent = `${src} • ${Math.round((solution.confidence_score || 1) * 100)}% Confidence`;
    }
    if (btnFlag) {
      btnFlag.className = "hud-btn-flag";
      btnFlag.innerHTML = "<span>🚩 Flag Wrong</span>";
    }
  }

  // ==========================================================================
  // Core Actions: Solve & Apply
  // ==========================================================================
  function extractCurrentQuiz(callback) {
    const ext = window.QuizZyExtractor || window.__QuizZyExtractor;
    if (ext && typeof ext.extractQuizFromDom === "function") {
      const res = ext.extractQuizFromDom();
      if (callback) callback(res);
      return;
    }
    // Fallback: message background service worker
    sendExtensionMessage({ action: "EXTRACT_QUIZ" }, (res) => {
      if (callback) callback(res);
    });
  }

  function solveCurrentQuestion(onComplete) {
    setSolvingState();
    extractCurrentQuiz((extracted) => {
      if (!extracted || !extracted.success || !extracted.question) {
        renderSolution({ status: "error", reason: extracted?.error || "Could not detect active quiz question on page." });
        if (onComplete) onComplete(null, extracted);
        return;
      }

      const solvePayload = {
        subject: extracted.subject || "General",
        q_type: extracted.q_type || "auto",
        question: extracted.question,
        options: extracted.options || [],
        bypass_cache: false
      };

      sendExtensionMessage({ action: "SOLVE_REQUEST", payload: solvePayload }, (res) => {
        if (!res || !res.success || !res.data) {
          renderSolution({ status: "error", reason: res?.error || "Backend solve request failed." }, extracted);
          if (onComplete) onComplete(null, extracted);
          return;
        }

        renderSolution(res.data, extracted);
        if (onComplete) onComplete(res.data, extracted);
      });
    });
  }

  function applyCurrentSolution(onComplete) {
    if (!latestSolution || latestSolution.status !== "ok") {
      if (onComplete) onComplete({ success: false, error: "No valid solution to apply." });
      return;
    }

    const actionPayload = {
      q_type: latestSolution.q_type,
      selected_index: latestSolution.selected_index,
      selected_text: latestSolution.selected_text,
      answer: latestSolution.answer,
      permutation_indices: latestSolution.permutation_indices,
      ordered_texts: latestSolution.ordered_texts
    };

    const exec = window.QuizZyExecutor || window.__QuizZyExecutor;
    if (exec && typeof exec.executeAction === "function") {
      const res = exec.executeAction(actionPayload);
      if (pillText) pillText.textContent = `Applied: ${pillText.textContent}`;
      if (onComplete) onComplete(res);
      return;
    }

    sendExtensionMessage({ action: "EXECUTE_QUIZ_ACTION", payload: actionPayload }, (res) => {
      if (pillText && res && res.success) {
        pillText.textContent = `Applied: ${pillText.textContent}`;
      }
      if (onComplete) onComplete(res);
    });
  }

  // ==========================================================================
  // Autonomous Mode Execution Loop with Guardrails
  // ==========================================================================
  let autoStepCount = 0;
  let autoMaxSteps = 10;
  let prevAutoSig = "";
  let stuckCount = 0;

  function getQuestionSig(extracted) {
    if (!extracted || !extracted.question) return "";
    const qStr = String(extracted.question || "").trim();
    const optsStr = Array.isArray(extracted.options)
      ? extracted.options.map((o) => (typeof o === "string" ? o.trim() : JSON.stringify(o))).join("|")
      : "";
    return `${qStr}||${optsStr}`;
  }

  function clickNextOnPage(callback) {
    const exec = window.QuizZyExecutor || window.__QuizZyExecutor;
    if (exec && typeof exec.clickNextButton === "function") {
      exec.clickNextButton().then((res) => {
        if (callback) callback(res);
      }).catch((err) => {
        if (callback) callback({ ok: false, error: err.message });
      });
      return;
    }

    sendExtensionMessage({ action: "CLICK_NEXT_BUTTON" }, (res) => {
      if (callback) callback(res);
    });
  }

  function waitForQuestionAdvance(oldSig, onReady, maxWaitMs = 3800) {
    const start = Date.now();
    const pollInterval = 150;

    function poll() {
      if (!isAutoRunning) return;

      extractCurrentQuiz((newExt) => {
        if (!isAutoRunning) return;

        const newSig = getQuestionSig(newExt);
        if (newSig && newSig !== oldSig) {
          onReady(newExt);
          return;
        }

        if (Date.now() - start >= maxWaitMs) {
          onReady(newExt);
          return;
        }

        setTimeout(poll, pollInterval);
      });
    }

    setTimeout(poll, 250);
  }

  function startAutoMode() {
    // Check host allowlist
    const hostname = (window.location && window.location.hostname) ? window.location.hostname.toLowerCase() : "localhost";
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || !hostname;

    storage.get(["auto_mode_allowlist", "auto_max_steps"], (res) => {
      const allowlist = Array.isArray(res?.auto_mode_allowlist) ? res.auto_mode_allowlist : ["localhost", "127.0.0.1", "::1"];
      const allowed = isLocal || allowlist.includes(hostname) || (window.location.protocol === "file:");

      if (!allowed) {
        if (pillText) pillText.textContent = `Auto Mode Blocked: ${hostname} not in Allowlist`;
        return;
      }

      isAutoRunning = true;
      autoStepCount = 0;
      autoMaxSteps = Math.min(100, Math.max(1, parseInt(res?.auto_max_steps || 10)));
      prevAutoSig = "";
      stuckCount = 0;

      if (btnAuto) {
        btnAuto.classList.add("running");
        if (autoLabel) autoLabel.textContent = "Stop";
        if (autoIcon) {
          autoIcon.innerHTML = '<rect x="6" y="6" width="12" height="12" fill="currentColor"></rect>';
        }
      }

      runAutoStep();
    });
  }

  function stopAutoMode(reason = "") {
    isAutoRunning = false;
    if (btnAuto) {
      btnAuto.classList.remove("running");
      if (autoLabel) autoLabel.textContent = "Auto";
      if (autoIcon) {
        autoIcon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3" fill="currentColor"></polygon>';
      }
    }
    if (reason && pillText) {
      pillText.textContent = `Auto Halted: ${reason}`;
    }
  }

  function runAutoStep() {
    if (!isAutoRunning) return;

    if (autoStepCount >= autoMaxSteps) {
      stopAutoMode(`Reached limit of ${autoMaxSteps} steps.`);
      return;
    }

    autoStepCount++;
    if (pillBadge) {
      pillBadge.className = "hud-pill-badge";
      pillBadge.textContent = `Auto [${autoStepCount}/${autoMaxSteps}]`;
    }

    solveCurrentQuestion((solution, extracted) => {
      if (!isAutoRunning) return;

      if (!solution || solution.status !== "ok" || solution.confidence_label === "uncertain") {
        stopAutoMode("Model consensus uncertain. Guardrail halted.");
        return;
      }

      // Check stuck question
      const sig = getQuestionSig(extracted);
      if (prevAutoSig && sig === prevAutoSig) {
        stuckCount++;
        if (stuckCount >= 2) {
          stopAutoMode("Question did not advance after submit.");
          return;
        }
      } else {
        prevAutoSig = sig;
        stuckCount = 0;
      }

      // Apply answer to page
      applyCurrentSolution((actionRes) => {
        if (!isAutoRunning) return;

        // Small delay then click Next
        setTimeout(() => {
          if (!isAutoRunning) return;

          clickNextOnPage((nextRes) => {
            if (!isAutoRunning) return;

            if (nextRes && nextRes.step === "quiz_completed") {
              stopAutoMode("Quiz completed successfully!");
              return;
            }

            // Wait for next question to load
            waitForQuestionAdvance(sig, (newExt) => {
              if (!isAutoRunning) return;
              // Brief pause before next cycle
              setTimeout(runAutoStep, 450);
            });
          });
        }, 500);
      });
    });
  }

  // ==========================================================================
  // UI Interactions & Toggles
  // ==========================================================================
  function setMinimized(minimized) {
    isMinimizedState = minimized;
    storage.set({ quizzy_hud_minimized: minimized });
    if (minimized) {
      if (fullBar) fullBar.classList.add("hidden");
      if (minimizedPill) minimizedPill.classList.remove("hidden");
    } else {
      if (minimizedPill) minimizedPill.classList.add("hidden");
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

  // Button listeners
  if (btnSolve) {
    btnSolve.addEventListener("click", () => solveCurrentQuestion());
  }

  if (btnApply) {
    btnApply.addEventListener("click", () => applyCurrentSolution());
  }

  if (btnAuto) {
    btnAuto.addEventListener("click", () => {
      if (isAutoRunning) {
        stopAutoMode("Halted by user.");
      } else {
        startAutoMode();
      }
    });
  }

  if (btnInfo) {
    btnInfo.addEventListener("click", () => {
      isDrawerOpen = !isDrawerOpen;
      if (isDrawerOpen) {
        drawer.classList.remove("hidden");
      } else {
        drawer.classList.add("hidden");
      }
    });
  }

  if (btnMinimize) {
    btnMinimize.addEventListener("click", () => setMinimized(true));
  }

  if (minimizedPill) {
    minimizedPill.addEventListener("click", (e) => {
      if (!isDragging) setMinimized(false);
    });
  }

  if (btnClose) {
    btnClose.addEventListener("click", hide);
  }

  if (btnFlag) {
    btnFlag.addEventListener("click", () => {
      if (!latestSolution || !latestExtracted) return;
      btnFlag.disabled = true;
      btnFlag.innerHTML = "<span>Flagging...</span>";

      const feedbackPayload = {
        subject: latestExtracted.subject || "General",
        q_type: latestSolution.q_type || "mcq",
        question: latestExtracted.question,
        options: latestExtracted.options || [],
        wrong_answer: latestSolution.answer,
        is_unverified_flag: true
      };

      sendExtensionMessage({ action: "SUBMIT_FEEDBACK", payload: feedbackPayload }, (res) => {
        btnFlag.disabled = false;
        if (res && res.success) {
          btnFlag.className = "hud-btn-flag flagged";
          btnFlag.innerHTML = "<span>✓ Flagged & Evicted</span>";
          if (pillText) pillText.textContent = "Answer flagged wrong. Cache evicted.";
        } else {
          btnFlag.innerHTML = "<span>Flag Failed</span>";
        }
      });
    });
  }

  // ==========================================================================
  // Global Keyboard Shortcuts (Alt+S, Alt+A, Escape)
  // ==========================================================================
  function onKeyDown(e) {
    // Escape key kill switch
    if (e.key === "Escape" || e.key === "Esc") {
      if (isAutoRunning) {
        stopAutoMode("Escape key kill switch triggered.");
        e.preventDefault();
        return;
      }
    }

    // Alt+S: Extract & Solve
    if (e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      solveCurrentQuestion();
      return;
    }

    // Alt+A: Apply Answer Once
    if (e.altKey && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      applyCurrentSolution();
      return;
    }
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("keydown", onKeyDown, true);
  }

  // Runtime message listener for kill switch & commands from background
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.action) return;
      if (message.action === "KILL_SWITCH_TRIGGERED") {
        if (isAutoRunning) {
          stopAutoMode(message.reason || "Background kill switch triggered.");
        }
      }
      if (message.action === "TOGGLE_FLOATING_HUD_COMMAND") {
        toggleVisibility();
      }
    });
  }

  // ==========================================================================
  // Export Instance to Window
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
