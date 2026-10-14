/**
 * QuizZy - DOM Action Executor (Phase 3 Auto Mode)
 * 
 * Strict Guardrail Architecture:
 * - Plain DOM element clicks (.click() / MouseEvent)
 * - Native property descriptor value setting + input/change event dispatch for React/Vue/Angular text inputs
 * - Verified HTML5 DragEvent reordering with post-drag order check (safe-pause fallback if unmoved)
 * - Next/Submit button navigation clicker
 * - ZERO node creation, ZERO DOM attribute/class tampering, ZERO style injection
 */

(function () {
  "use strict";

  /**
   * Cleans text content for matching.
   */
  function cleanText(text) {
    if (!text) return "";
    return String(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Checks if an element is visible in the layout.
   */
  function isVisible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    if (typeof window !== "undefined" && window.getComputedStyle) {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          return false;
        }
      } catch (e) {
        // Fallback if computed style throws
      }
    }
    return true;
  }

  /**
   * Dispatches a realistic mouse click on an element.
   */
  function dispatchClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ behavior: "instant", block: "nearest" });
    } catch (e) {}

    try {
      el.focus();
    } catch (e) {}

    // Dispatch pointer and mouse events in realistic sequence
    const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    eventTypes.forEach((type) => {
      try {
        let ev;
        if (type.startsWith("pointer") && typeof PointerEvent !== "undefined") {
          ev = new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            buttons: 1,
            pointerId: 1,
            pointerType: "mouse"
          });
        } else {
          ev = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            buttons: 1
          });
        }
        el.dispatchEvent(ev);
      } catch (e) {}
    });

    // Native click fallback
    if (typeof el.click === "function") {
      try {
        el.click();
      } catch (e) {}
    }
    return true;
  }

  /**
   * Finds option elements using custom selector or deterministic heuristics.
   */
  function findOptionElements(customSelector) {
    const doc = (typeof document !== "undefined") ? document : null;
    if (!doc) return [];

    if (customSelector) {
      const customMatches = Array.from(doc.querySelectorAll(customSelector)).filter(isVisible);
      if (customMatches.length > 0) return customMatches;
    }

    // Check for radio button groups
    const radioInputs = Array.from(doc.querySelectorAll("input[type='radio']")).filter(isVisible);
    if (radioInputs.length >= 2 && radioInputs.length <= 10) {
      const radioRows = radioInputs.map((r) => {
        const lbl = r.closest("label") || (r.id ? doc.querySelector(`label[for="${r.id}"]`) : null);
        if (lbl && isVisible(lbl)) return lbl;
        const row = r.closest("[class*='option'], [class*='choice'], [class*='radio'], li, tr") || r.parentElement;
        return (row && isVisible(row)) ? row : r;
      });
      if (radioRows.length >= 2 && radioRows.length <= 10) {
        return radioRows;
      }
    }

    const optionHeuristics = [
      "[data-quiz-option]",
      ".quiz-option",
      ".option-item",
      ".draggable-item",
      "[draggable='true']",
      "[role='option']",
      "[role='radio']",
      "[class*='radio-item']",
      "[class*='option-item']",
      ".quiz-choice",
      ".option-card",
      "li.choice",
      ".order-item",
      ".sortable-block"
    ];

    for (const sel of optionHeuristics) {
      const matches = Array.from(doc.querySelectorAll(sel)).filter(isVisible);
      if (matches.length >= 2 && matches.length <= 10) {
        return matches;
      }
    }
    return [];
  }

  /**
   * Executes plain DOM click on targeted MCQ option.
   * Handles React 16-18 controlled radio selection without corrupting _valueTracker.
   */
  function executeMcqAction(payload) {
    const targetIndex = payload.selected_index;
    if (typeof targetIndex !== "number" || targetIndex < 0) {
      return { success: false, error: `Invalid selected_index: ${targetIndex}` };
    }

    const options = findOptionElements(payload.optionsSelector);
    if (options.length === 0) {
      return { success: false, error: "No option elements found on host page." };
    }

    if (targetIndex >= options.length) {
      return {
        success: false,
        error: `Target option index ${targetIndex} out of bounds (found ${options.length} options).`
      };
    }

    const targetEl = options[targetIndex];
    const radio = targetEl.querySelector
      ? (targetEl.querySelector("input[type='radio']") || (targetEl.tagName === "INPUT" && targetEl.type === "radio" ? targetEl : null))
      : null;

    // 1. Dispatch realistic mouse interaction sequence on the label or interactive card FIRST
    // CRITICAL: Do NOT pre-mutate radio.checked = true before click, which breaks React 16-18 _valueTracker!
    const clickTarget = (targetEl.tagName === "INPUT" && targetEl.parentElement && targetEl.parentElement.tagName === "LABEL")
      ? targetEl.parentElement
      : targetEl;

    const clicked = dispatchClick(clickTarget);
    if (radio && radio !== clickTarget) {
      dispatchClick(radio);
    }

    // 2. React 16-18 controlled radio fallback: only if radio is STILL not checked after click
    if (radio && !radio.checked) {
      try {
        if (radio._valueTracker && typeof radio._valueTracker.setValue === "function") {
          radio._valueTracker.setValue(false);
        }
      } catch (e) {}

      try {
        const proto = (typeof window !== "undefined" && window.HTMLInputElement)
          ? window.HTMLInputElement.prototype
          : null;
        const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, "checked") : null;
        if (descriptor && descriptor.set) {
          descriptor.set.call(radio, true);
        } else {
          radio.checked = true;
        }
      } catch (e) {
        radio.checked = true;
      }

      try {
        radio.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        radio.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      } catch (e) {}
    }

    return {
      success: clicked,
      action: "mcq_click",
      selected_index: targetIndex,
      option_text: cleanText(targetEl.innerText || targetEl.textContent)
    };
  }

  /**
   * Executes React/Vue/Angular compatible text input entry.
   */
  function executeTextAction(payload) {
    const textVal = payload.answer || payload.selected_text || "";
    const doc = (typeof document !== "undefined") ? document : null;
    if (!doc) return { success: false, error: "No document" };

    let inputEl = null;
    if (payload.textInputSelector) {
      inputEl = doc.querySelector(payload.textInputSelector);
    }

    if (!inputEl) {
      const inputHeuristics = [
        "[data-quiz-input]",
        "input.quiz-input",
        "input.fill-blank",
        "textarea.quiz-input",
        ".question-container input[type='text']",
        ".question-container textarea",
        "input[type='text']:not([aria-hidden='true'])",
        "textarea:not([aria-hidden='true'])",
        "input:not([type]):not([aria-hidden='true'])"
      ];
      for (const sel of inputHeuristics) {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) {
          inputEl = el;
          break;
        }
      }
    }

    if (!inputEl) {
      return { success: false, error: "Target text input element not found on page." };
    }

    try {
      inputEl.focus();
    } catch (e) {}

    // Use native prototype property descriptor to bypass React/Vue value interception
    try {
      const isTextArea = inputEl.tagName.toLowerCase() === "textarea";
      const prototype = isTextArea
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

      if (descriptor && descriptor.set) {
        descriptor.set.call(inputEl, textVal);
      } else {
        inputEl.value = textVal;
      }
    } catch (e) {
      inputEl.value = textVal;
    }

    // Dispatch input and change events
    try {
      inputEl.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    } catch (e) {}

    return {
      success: true,
      action: "text_fill",
      value: textVal
    };
  }

  /**
   * Helper to create a synthetic DataTransfer instance for HTML5 drag events.
   */
  function createSyntheticDataTransfer() {
    const dataStore = {};
    return {
      dropEffect: "move",
      effectAllowed: "all",
      files: [],
      items: [],
      types: [],
      setData: function (format, data) {
        dataStore[format] = data;
        if (!this.types.includes(format)) this.types.push(format);
      },
      getData: function (format) {
        return dataStore[format] || "";
      },
      clearData: function (format) {
        if (format) {
          delete dataStore[format];
          const idx = this.types.indexOf(format);
          if (idx !== -1) this.types.splice(idx, 1);
        } else {
          this.types = [];
        }
      }
    };
  }

  /**
   * Dispatches a full HTML5 drag-and-drop sequence between source and target elements.
   */
  function simulateDragDrop(sourceEl, targetEl) {
    if (!sourceEl || !targetEl || sourceEl === targetEl) return;
    const dt = createSyntheticDataTransfer();

    function fireDragEvent(type, el) {
      let ev;
      try {
        ev = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          dataTransfer: dt
        });
      } catch (e) {
        // Fallback for environments where DragEvent constructor is restricted
        ev = document.createEvent("CustomEvent");
        ev.initCustomEvent(type, true, true, null);
        ev.dataTransfer = dt;
      }
      el.dispatchEvent(ev);
    }

    fireDragEvent("dragstart", sourceEl);
    fireDragEvent("dragenter", targetEl);
    fireDragEvent("dragover", targetEl);
    fireDragEvent("drop", targetEl);
    fireDragEvent("dragend", sourceEl);
  }

  /**
   * Executes verified Order reordering with post-drag order check.
   * If simulated drag events do not cause the host page elements to reorder,
   * cleanly returns unmoved: true so Auto Mode can safely pause.
   */
  function executeOrderAction(payload) {
    const permutationIndices = payload.permutation_indices;
    const orderedTexts = payload.ordered_texts || [];

    if (!Array.isArray(permutationIndices) || permutationIndices.length < 2) {
      return { success: false, error: "Invalid permutation_indices for order action." };
    }

    const elements = findOptionElements(payload.optionsSelector);
    if (elements.length !== permutationIndices.length) {
      return {
        success: false,
        error: `Element count mismatch: found ${elements.length} blocks, expected ${permutationIndices.length}`
      };
    }

    // Capture initial text order before drag simulation
    const initialTexts = elements.map(el => cleanText(el.innerText || el.textContent));

    // Attempt sequential pairwise drag swaps based on target permutation
    // permutationIndices[targetSlot] = originalBlockIndex
    for (let targetSlot = 0; targetSlot < permutationIndices.length; targetSlot++) {
      const origIndex = permutationIndices[targetSlot];
      if (origIndex !== targetSlot && elements[origIndex] && elements[targetSlot]) {
        simulateDragDrop(elements[origIndex], elements[targetSlot]);
      }
    }

    // Post-drag verification: check if host DOM elements actually changed order
    const updatedElements = findOptionElements(payload.optionsSelector);
    const postTexts = updatedElements.map(el => cleanText(el.innerText || el.textContent));

    // Check if elements match orderedTexts
    let matchesTarget = true;
    if (orderedTexts.length === postTexts.length) {
      for (let i = 0; i < orderedTexts.length; i++) {
        if (!postTexts[i].includes(cleanText(orderedTexts[i])) && !cleanText(orderedTexts[i]).includes(postTexts[i])) {
          matchesTarget = false;
          break;
        }
      }
    } else {
      matchesTarget = false;
    }

    // Check if any change occurred at all
    const hasMoved = JSON.stringify(initialTexts) !== JSON.stringify(postTexts);

    if (!matchesTarget) {
      return {
        success: false,
        unmoved: !hasMoved,
        action: "order_swap_attempted",
        reason: hasMoved
          ? "Blocks shifted but do not match verified target sequence. Safe manual pause required."
          : "Host page drag library did not respond to synthetic DragEvents. Safe manual swap required.",
        current_order: postTexts,
        target_order: orderedTexts
      };
    }

    return {
      success: true,
      action: "order_reordered",
      verified: true
    };
  }

  /**
   * Finds and clicks the Next / Submit / Advance question button on the host page.
   * Handles the two-step SUBMIT -> NEXT button flow for quiz platforms like learning.ccbp.in.
   */
  async function clickNextButton(customNextSelector) {
    const doc = (typeof document !== "undefined") ? document : null;
    if (!doc) return { success: false, error: "No document" };

    // Ignore non-advance buttons like SHOW ANSWER, SKIP, END PRACTICE, HINT, PREVIOUS, BACK, REPORT
    function isIgnoredButton(btn) {
      if (!btn) return true;
      const t = cleanText(btn.innerText || btn.textContent || btn.value || btn.getAttribute("aria-label") || "").toLowerCase();
      if (/^(?:show answer|skip|end practice|practice instructions|reset|cancel|hint|previous|prev|back|report|report an issue|review)\b/i.test(t)) {
        return true;
      }
      return false;
    }

    function isNextCandidate(btn) {
      if (!btn || isIgnoredButton(btn) || btn.disabled) return false;
      const t = cleanText(btn.innerText || btn.textContent || btn.value || btn.getAttribute("aria-label") || "").toLowerCase();
      if (/^(?:next|continue|advance|forward|next question)\b/i.test(t)) return true;
      if (btn.matches && (btn.matches("[data-quiz-next]") || btn.matches(".btn-next") || btn.matches(".next-btn") || btn.matches(".quiz-next") || btn.matches(".next-button"))) return true;
      return false;
    }

    function isSubmitCandidate(btn) {
      if (!btn || isIgnoredButton(btn) || btn.disabled) return false;
      const t = cleanText(btn.innerText || btn.textContent || btn.value || btn.getAttribute("aria-label") || "").toLowerCase();
      if (/^(?:submit|check answer|check|submit answer)\b/i.test(t)) return true;
      if (btn.type === "submit" && !isNextCandidate(btn)) return true;
      return false;
    }

    function findReadyNext(customSelector) {
      if (customSelector) {
        try {
          const el = doc.querySelector(customSelector);
          if (el && isVisible(el) && !el.disabled && !isIgnoredButton(el)) {
            return el;
          }
        } catch (e) {}
      }

      const allButtons = Array.from(doc.querySelectorAll(
        "button, a.btn, [role='button'], input[type='button'], input[type='submit']"
      )).filter(isVisible);

      const candidate = allButtons.find(isNextCandidate);
      if (candidate) return candidate;

      const nextHeuristics = [
        "[data-quiz-next]",
        "#next-question",
        ".btn-next",
        ".next-btn",
        "button.quiz-next",
        "button.next-button"
      ];
      for (const sel of nextHeuristics) {
        try {
          const el = doc.querySelector(sel);
          if (el && isVisible(el) && !el.disabled && !isIgnoredButton(el)) {
            return el;
          }
        } catch (e) {}
      }
      return null;
    }

    // (A) Check if NEXT button is ALREADY visible and enabled
    const directNext = findReadyNext(customNextSelector);
    if (directNext) {
      const clicked = dispatchClick(directNext);
      const btnText = cleanText(directNext.innerText || directNext.textContent || directNext.value || "Next");
      return {
        ok: clicked,
        success: clicked,
        step: "next_direct",
        action: "next_button_clicked",
        button_text: btnText
      };
    }

    // (B) If not, check if a SUBMIT button is present (two-step submit -> next)
    const allButtons = Array.from(doc.querySelectorAll(
      "button, a.btn, [role='button'], input[type='button'], input[type='submit']"
    )).filter(isVisible);

    const submitBtn = allButtons.find(isSubmitCandidate);
    if (submitBtn) {
      const submitText = cleanText(submitBtn.innerText || submitBtn.textContent || submitBtn.value || "Submit");
      dispatchClick(submitBtn);

      // Deterministic polling: check every 120ms up to 4500ms for NEXT button to appear/enable
      const pollIntervalMs = 120;
      const maxWaitMs = 4500;
      let waitedMs = 0;
      let postNext = null;

      while (waitedMs < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        waitedMs += pollIntervalMs;

        postNext = findReadyNext(customNextSelector);
        if (postNext) {
          break;
        }
      }

      if (postNext) {
        const nextClicked = dispatchClick(postNext);
        const nextText = cleanText(postNext.innerText || postNext.textContent || postNext.value || "Next Question");
        return {
          ok: nextClicked,
          success: nextClicked,
          step: "submit_then_next",
          action: "submit_then_next_clicked",
          button_text: `${submitText} -> ${nextText}`,
          waited_ms: waitedMs
        };
      }

      // If no NEXT button rendered after submit within maxWaitMs, check if quiz completed
      const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || "") : "";
      const isCompleted = /(?:questions?\s*attempted\s*:\s*(\d+)\s*\/\s*\1|quiz\s*completed|practice\s*completed|all\s*questions?\s*(?:attempted|answered))/i.test(bodyText);

      return {
        ok: true,
        success: true,
        step: isCompleted ? "quiz_completed" : "submit_only",
        action: isCompleted ? "quiz_completed" : "submit_clicked",
        button_text: submitText,
        waited_ms: waitedMs,
        reason: isCompleted
          ? "Quiz completed (all questions attempted or completion banner detected)."
          : "Submit clicked, but no Next button appeared within 4500ms."
      };
    }

    // (C) If neither Next nor Submit found, check if quiz is already completed
    const bodyText = doc.body ? (doc.body.innerText || doc.body.textContent || "") : "";
    if (/(?:questions?\s*attempted\s*:\s*(\d+)\s*\/\s*\1|quiz\s*completed|practice\s*completed)/i.test(bodyText)) {
      return {
        ok: true,
        success: true,
        step: "quiz_completed",
        action: "quiz_completed",
        reason: "Quiz completion detected."
      };
    }

    return {
      ok: false,
      success: false,
      error: "Next / Continue button not found. Please specify 'Next Button Selector' in Settings."
    };
  }

  /**
   * Main router for executing quiz actions.
   */
  function executeAction(payload) {
    if (!payload || !payload.q_type) {
      return { success: false, error: "Payload missing q_type" };
    }

    const qType = String(payload.q_type).toLowerCase().trim();

    if (qType === "mcq") {
      return executeMcqAction(payload);
    } else if (qType === "text") {
      return executeTextAction(payload);
    } else if (qType === "order") {
      return executeOrderAction(payload);
    } else {
      return { success: false, error: `Unsupported action q_type: ${qType}` };
    }
  }

  // Export to window for Chrome isolated world execution and module for testing
  const QuizZyExecutor = {
    cleanText,
    isVisible,
    dispatchClick,
    findOptionElements,
    executeMcqAction,
    executeTextAction,
    simulateDragDrop,
    executeOrderAction,
    clickNextButton,
    executeAction
  };

  if (typeof window !== "undefined") {
    window.QuizZyExecutor = QuizZyExecutor;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = QuizZyExecutor;
  }
})();
