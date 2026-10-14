/**
 * QuizZy - Manifest V3 Background Service Worker
 * 
 * Handles:
 * 1. Side panel open behavior & floating HUD injection
 * 2. On-demand script injection (extractor.js, executor.js, floating_hud.js) in ISOLATED world
 * 3. Proxying solve and health requests to local FastAPI backend (http://127.0.0.1:8000)
 * 4. Multi-trigger emergency kill switch (tab change, navigation away from quiz page)
 */

"use strict";

const BACKEND_BASE_URL = "http://127.0.0.1:8000";

// Helper to resolve target tab: sender tab -> message.tabId -> active tab query
async function resolveTargetTab(message, sender) {
  if (message && message.tabId) {
    try {
      const tab = await chrome.tabs.get(message.tabId);
      if (tab) return tab;
    } catch (_) {}
  }
  if (sender && sender.tab && sender.tab.id) {
    return sender.tab;
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return (tabs && tabs[0]) ? tabs[0] : null;
}

// Injects extractor, executor, and floating HUD into target tab
async function injectAndToggleFloatingHud(tabId, shouldToggle = true) {
  if (!tabId) return { success: false };
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["extractor.js"]
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["executor.js"]
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["floating_hud.js"]
    });

    if (shouldToggle) {
      chrome.tabs.sendMessage(tabId, { action: "TOGGLE_FLOATING_HUD_COMMAND" }).catch(() => {});
    } else {
      chrome.tabs.sendMessage(tabId, { action: "SHOW_FLOATING_HUD_COMMAND" }).catch(() => {});
    }

    return results && results[0] ? results[0].result : { success: true };
  } catch (err) {
    console.warn("[QuizZy Service Worker] Injection failed:", err);
    return { success: false, error: err.message };
  }
}

// Pre-seed default allowed hosts in chrome.storage.local (including learning.ccbp.in)
function initializeStorageDefaults() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["allowedHosts"], (data) => {
      const current = data.allowedHosts || [];
      const defaults = ["127.0.0.1", "localhost", "::1", "learning.ccbp.in"];
      let modified = false;
      for (const d of defaults) {
        if (!current.includes(d)) {
          current.push(d);
          modified = true;
        }
      }
      if (modified || !data.allowedHosts) {
        chrome.storage.local.set({ allowedHosts: current });
      }
    });
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    initializeStorageDefaults();
  });
}
initializeStorageDefaults();

// Configure side panel behavior: Disable opening on action click so Floating Bar is the primary UX
if (typeof chrome !== "undefined" && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch((err) => {
    console.warn("[QuizZy Service Worker] setPanelBehavior warning:", err);
  });
}

// Action click listener: Clicking extension toolbar icon immediately toggles the Floating Bar on page!
if (typeof chrome !== "undefined" && chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab && tab.id) {
      try {
        await injectAndToggleFloatingHud(tab.id, true);
      } catch (err) {
        console.warn("[QuizZy Service Worker] Failed to toggle floating HUD on action click:", err);
      }
    }
  });
}

// ==========================================================================
// Emergency Kill Switch & Auto-Injection Listeners
// ==========================================================================
if (typeof chrome !== "undefined" && chrome.tabs) {
  // If the user switches away to a different tab, immediately notify the HUD to halt Auto Mode
  if (chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener((activeInfo) => {
      chrome.runtime.sendMessage({
        action: "KILL_SWITCH_TRIGGERED",
        reason: "Active tab changed by user. Auto Mode paused for safety.",
        tabId: activeInfo.tabId
      }).catch(() => {});
    });
  }

  // If page navigates away, halt Auto Mode; when page finishes loading on allowed host, auto-inject HUD!
  if (chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === "loading" && changeInfo.url) {
        chrome.runtime.sendMessage({
          action: "KILL_SWITCH_TRIGGERED",
          reason: `Page navigated to ${changeInfo.url}. Auto Mode halted.`,
          tabId: tabId
        }).catch(() => {});
      }

      // Auto-launch Floating Bar on allowed host pages as soon as loading completes
      if (changeInfo.status === "complete" && tab && tab.url) {
        try {
          const urlObj = new URL(tab.url);
          const hostname = urlObj.hostname.toLowerCase();
          const defaultAllowed = ["learning.ccbp.in", "127.0.0.1", "localhost", "::1"];
          
          if (defaultAllowed.includes(hostname)) {
            injectAndToggleFloatingHud(tabId, false);
          } else if (chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(["allowedHosts"], (data) => {
              const allowed = data.allowedHosts || [];
              if (allowed.includes(hostname)) {
                injectAndToggleFloatingHud(tabId, false);
              }
            });
          }
        } catch (_) {}
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
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found in current window." });
        return;
      }
      const tabId = targetTab.id;
      const url = targetTab.url || "";

      // Check for restricted URLs (chrome://, edge://, etc.)
      if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("chrome-extension://")) {
        sendResponse({
          success: false,
          error: "Cannot run DOM extraction on internal browser management pages (" + url + ")."
        });
        return;
      }

      try {
        const injectionResults = await chrome.scripting.executeScript({
          target: { tabId },
          world: "ISOLATED",
          files: ["extractor.js"]
        });

        let extractionResult = (injectionResults && injectionResults[0]) ? injectionResults[0].result : null;

        const hasCustomParams = (message.customSelectors && Object.keys(message.customSelectors).length > 0) ||
                                (message.forcedQType && message.forcedQType !== "auto");

        if (!extractionResult || hasCustomParams) {
          const executionResults = await chrome.scripting.executeScript({
            target: { tabId },
            world: "ISOLATED",
            func: (customSelectors, forcedQType) => {
              const ext = window.QuizZyExtractor || window.__QuizZyExtractor;
              if (ext && typeof ext.extractQuizFromDom === "function") {
                return ext.extractQuizFromDom(customSelectors, forcedQType);
              }
              if (window.__QUIZZY_LAST_EXTRACTION__) {
                return window.__QUIZZY_LAST_EXTRACTION__;
              }
              return { success: false, error: "QuizZyExtractor was not found in the active tab context." };
            },
            args: [message.customSelectors || {}, message.forcedQType || "auto"]
          });

          if (executionResults && executionResults[0] && executionResults[0].result) {
            extractionResult = executionResults[0].result;
          }
        }

        if (extractionResult) {
          sendResponse(extractionResult);
        } else {
          sendResponse({ success: false, error: "Extraction returned an empty or invalid result." });
        }
      } catch (err) {
        sendResponse({ success: false, error: `Script execution error: ${err.message}` });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // asynchronous response
  }

  // 4. Opt-in DOM highlight on active tab
  if (action === "APPLY_HIGHLIGHT") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found." });
        return;
      }
      const tabId = targetTab.id;
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
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 5. Query active tab information (for per-hostname settings & allowlist)
  if (action === "GET_ACTIVE_TAB") {
    resolveTargetTab(message, sender).then((targetTab) => {
      if (targetTab) {
        sendResponse({
          success: true,
          tab: { id: targetTab.id, url: targetTab.url || "", title: targetTab.title || "" }
        });
      } else {
        sendResponse({ success: false, error: "No active tab found." });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 6. Execute Quiz Action (Auto Mode or Single-Step Apply)
  if (action === "EXECUTE_QUIZ_ACTION") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found for action execution." });
        return;
      }
      const tabId = targetTab.id;
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
            const exec = window.QuizZyExecutor || window.__QuizZyExecutor;
            if (exec && typeof exec.executeAction === "function") {
              return exec.executeAction(payload);
            }
            return { success: false, error: "QuizZyExecutor not loaded in tab." };
          },
          args: [message.payload || {}]
        });

        sendResponse(results && results[0] ? results[0].result : { success: false, error: "Empty action execution." });
      } catch (err) {
        sendResponse({ success: false, error: `Action execution error: ${err.message}` });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // 7. Click Next / Advance Button
  if (action === "CLICK_NEXT_BUTTON") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found for Next button click." });
        return;
      }
      const tabId = targetTab.id;
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
            const exec = window.QuizZyExecutor || window.__QuizZyExecutor;
            if (exec && typeof exec.clickNextButton === "function") {
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
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
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

  // 9. Toggle / Launch Floating HUD on Active Quiz Tab
  if (action === "TOGGLE_FLOATING_HUD") {
    resolveTargetTab(message, sender).then(async (targetTab) => {
      if (!targetTab || !targetTab.id) {
        sendResponse({ success: false, error: "No active tab found." });
        return;
      }
      const url = targetTab.url || "";
      if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("chrome-extension://")) {
        sendResponse({
          success: false,
          error: "Cannot inject Floating HUD on browser internal pages (" + url + ")."
        });
        return;
      }

      try {
        const hudRes = await injectAndToggleFloatingHud(targetTab.id);
        sendResponse({ success: true, result: hudRes });
      } catch (err) {
        sendResponse({ success: false, error: `HUD injection error: ${err.message}` });
      }
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // asynchronous response
  }

  return false;
});
