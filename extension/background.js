/**
 * QuizZy - Manifest V3 Background Service Worker
 * 
 * Handles:
 * 1. Side panel open behavior
 * 2. On-demand script injection (extractor.js, executor.js) in ISOLATED world
 * 3. Proxying solve and health requests to local FastAPI backend (http://127.0.0.1:8000)
 * 4. Multi-trigger emergency kill switch (tab change, navigation away from quiz page)
 */

"use strict";

const BACKEND_BASE_URL = "http://127.0.0.1:8000";

// Configure side panel behavior on installation / startup
if (typeof chrome !== "undefined" && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
    console.warn("[QuizZy Service Worker] setPanelBehavior warning:", err);
  });
}

// Fallback action click listener if setPanelBehavior is not supported
if (typeof chrome !== "undefined" && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (chrome.sidePanel && typeof chrome.sidePanel.open === "function") {
      try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      } catch (err) {
        console.warn("[QuizZy Service Worker] chrome.sidePanel.open fallback warning:", err);
      }
    }
  });
}

// ==========================================================================
// Emergency Kill Switch: Tab Switch & Navigation Listeners
// ==========================================================================
if (typeof chrome !== "undefined" && chrome.tabs) {
  // If the user switches away to a different tab, immediately notify the side panel to halt Auto Mode
  if (chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener((activeInfo) => {
      chrome.runtime.sendMessage({
        action: "KILL_SWITCH_TRIGGERED",
        reason: "Active tab changed by user. Auto Mode paused for safety.",
        tabId: activeInfo.tabId
      }).catch(() => {}); // Catch if side panel is closed
    });
  }

  // If the active page navigates away, halt Auto Mode
  if (chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === "loading" && changeInfo.url) {
        chrome.runtime.sendMessage({
          action: "KILL_SWITCH_TRIGGERED",
          reason: `Page navigated to ${changeInfo.url}. Auto Mode halted.`,
          tabId: tabId
        }).catch(() => {});
      }
    });
  }
}

// ==========================================================================
// Global Runtime Message Router
// ==========================================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    return false;
  }

  const action = message.action;

  // 1. Health check to local backend
  if (action === "CHECK_HEALTH") {
    fetch(`${BACKEND_BASE_URL}/health`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => sendResponse({ success: true, data }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // asynchronous response
  }

  // 2. Proxy solve request to local backend
  if (action === "SOLVE_REQUEST") {
    fetch(`${BACKEND_BASE_URL}/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.payload)
    })
      .then(async (res) => {
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          sendResponse({
            success: false,
            status: res.status,
            error: errorData.detail || `Server error (${res.status})`
          });
          return;
        }
        const data = await res.json();
        sendResponse({ success: true, data });
      })
      .catch((err) => {
        sendResponse({
          success: false,
          error: `Cannot reach QuizZy backend at ${BACKEND_BASE_URL}. Ensure it is running. (${err.message})`
        });
      });
    return true; // asynchronous response
  }

  // 3. Extract quiz from active tab DOM
  if (action === "EXTRACT_QUIZ") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || tabs.length === 0 || !tabs[0].id) {
        sendResponse({ success: false, error: "No active tab found in current window." });
        return;
      }
      const tabId = tabs[0].id;
      const url = tabs[0].url || "";

      // Check for restricted URLs (chrome://, edge://, etc.)
      if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("chrome-extension://")) {
        sendResponse({
          success: false,
          error: "Cannot run DOM extraction on internal browser management pages (" + url + ")."
        });
        return;
      }

      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          files: ["extractor.js"]
        });

        const executionResults = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: (customSelectors, forcedQType) => {
            if (window.QuizZyExtractor && typeof window.QuizZyExtractor.extractQuizFromDom === "function") {
              return window.QuizZyExtractor.extractQuizFromDom(customSelectors, forcedQType);
            }
            return { success: false, error: "QuizZyExtractor was not found in the active tab context." };
          },
          args: [message.customSelectors || {}, message.forcedQType || "auto"]
        });

        const extractionResult = executionResults && executionResults[0] ? executionResults[0].result : null;
        if (extractionResult) {
          sendResponse(extractionResult);
        } else {
          sendResponse({ success: false, error: "Extraction returned an empty or invalid result." });
        }
      } catch (err) {
        sendResponse({ success: false, error: `Script execution error: ${err.message}` });
      }
    });
    return true; // asynchronous response
  }

  // 4. Opt-in DOM highlight on active tab
  if (action === "APPLY_HIGHLIGHT") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || tabs.length === 0 || !tabs[0].id) {
        sendResponse({ success: false, error: "No active tab found." });
        return;
      }
      const tabId = tabs[0].id;
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          files: ["extractor.js"]
        });

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: (payload) => {
            if (window.QuizZyExtractor && typeof window.QuizZyExtractor.applyDomHighlight === "function") {
              return window.QuizZyExtractor.applyDomHighlight(payload);
            }
            return { success: false, error: "QuizZyExtractor not available." };
          },
          args: [message.payload || {}]
        });

        sendResponse(results && results[0] ? results[0].result : { success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    });
    return true;
  }

  // 5. Query active tab information (for per-hostname settings & allowlist)
  if (action === "GET_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        sendResponse({
          success: true,
          tab: { id: tabs[0].id, url: tabs[0].url || "", title: tabs[0].title || "" }
        });
      } else {
        sendResponse({ success: false, error: "No active tab found." });
      }
    });
    return true;
  }

  // 6. Execute Quiz Action (Auto Mode or Single-Step Apply)
  if (action === "EXECUTE_QUIZ_ACTION") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || tabs.length === 0 || !tabs[0].id) {
        sendResponse({ success: false, error: "No active tab found for action execution." });
        return;
      }
      const tabId = tabs[0].id;
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          files: ["executor.js"]
        });

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: (payload) => {
            if (window.QuizZyExecutor && typeof window.QuizZyExecutor.executeAction === "function") {
              return window.QuizZyExecutor.executeAction(payload);
            }
            return { success: false, error: "QuizZyExecutor not loaded in tab." };
          },
          args: [message.payload || {}]
        });

        sendResponse(results && results[0] ? results[0].result : { success: false, error: "Empty action execution." });
      } catch (err) {
        sendResponse({ success: false, error: `Action execution error: ${err.message}` });
      }
    });
    return true;
  }

  // 7. Click Next / Advance Button
  if (action === "CLICK_NEXT_BUTTON") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || tabs.length === 0 || !tabs[0].id) {
        sendResponse({ success: false, error: "No active tab found for Next button click." });
        return;
      }
      const tabId = tabs[0].id;
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          files: ["executor.js"]
        });

        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          func: async (customNextSelector) => {
            if (window.QuizZyExecutor && typeof window.QuizZyExecutor.clickNextButton === "function") {
              return await window.QuizZyExecutor.clickNextButton(customNextSelector);
            }
            return { success: false, error: "QuizZyExecutor not loaded in tab." };
          },
          args: [message.customNextSelector || ""]
        });

        sendResponse(results && results[0] ? results[0].result : { success: false, error: "Empty next button result." });
      } catch (err) {
        sendResponse({ success: false, error: `Next button click error: ${err.message}` });
      }
    });
    return true;
  }

  // 8. Submit Wrong-Answer Feedback & Overrides
  if (action === "SUBMIT_FEEDBACK") {
    fetch(`${BACKEND_BASE_URL}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.payload)
    })
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          sendResponse({
            success: false,
            status: res.status,
            error: errData.detail || `Server error (${res.status})`
          });
        } else {
          const data = await res.json();
          sendResponse({ success: true, data });
        }
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  return false;
});

