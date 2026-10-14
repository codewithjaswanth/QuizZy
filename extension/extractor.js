/**
 * QuizZy - Read-Only DOM Extractor
 * 
 * Strict Zero-DOM-Mutation by default:
 * extractQuizFromDom performs purely read-only queries (querySelector, textContent,
 * getAttribute, etc.) and NEVER mutates DOM nodes, attributes, classes, or styles.
 */

(function () {
  "use strict";

  /**
   * Cleans text content: trims whitespace, collapses inner spaces,
   * and removes zero-width characters.
   */
  function cleanText(text) {
    if (!text) return "";
    return String(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Strips decorative leading bullets/letters (e.g. 'A.', '1)', '(a)')
   * from option blocks to ensure clean text normalization without breaking
   * math fractions such as '1/6' or '2/36'.
   */
  function stripDecorativePrefix(text) {
    if (!text) return "";
    return text
      .replace(/^(?:[A-Za-z][\.\)\:\-]\s*|\([A-Za-z0-9]\)\s*|[0-9]+[\.\)\:\-]\s*|[\u2022\u25E6\u25AA\u2023]\s*)/, "")
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
        // Fallback if computed style fails
      }
    }
    return true;
  }

  /**
   * Math-Safe Text Reader:
   * Extracts clean visible text while ignoring assistive MathML/TeX duplication
   * and hidden screen-reader elements (ZERO DOM MUTATION).
   */
  function getCleanVisibleText(el) {
    if (!el) return "";

    function walk(node) {
      if (!node) return "";
      if (node.nodeType === 3) {
        return node.nodeValue || "";
      }
      if (node.nodeType !== 1) {
        return "";
      }

      const tag = node.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") {
        return "";
      }

      // Filter out KaTeX/MathJax duplicate assistive MathML or TeX annotations
      const cls = typeof node.className === "string" ? node.className : (node.getAttribute("class") || "");
      if (
        cls.includes("katex-mathml") ||
        cls.includes("MJX_Assistive_MathML") ||
        cls.includes("sr-only") ||
        cls.includes("visually-hidden") ||
        tag === "annotation" ||
        tag === "annotation-xml"
      ) {
        return "";
      }

      // Check inline display:none or visibility:hidden
      const styleAttr = node.getAttribute("style") || "";
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(styleAttr)) {
        return "";
      }
      if (node.hasAttribute("hidden")) {
        return "";
      }

      // KaTeX puts aria-hidden="true" on .katex-html, but that is the real visual math we want!
      const ariaHidden = node.getAttribute("aria-hidden");
      if (ariaHidden === "true" && !cls.includes("katex-html") && !node.closest(".katex-html")) {
        if (tag === "svg" || tag === "i" || tag === "img" || cls.includes("icon")) {
          return "";
        }
      }

      // Skip radio/checkbox inputs from contributing raw value text
      if (tag === "input" && (node.type === "radio" || node.type === "checkbox")) {
        return "";
      }

      let text = "";
      for (let child = node.firstChild; child; child = child.nextSibling) {
        text += walk(child);
      }
      return text;
    }

    return cleanText(walk(el));
  }

  /**
   * Identifies non-question header or navigation strings to prevent false positives.
   */
  function isHeaderOrNavText(text) {
    if (!text) return true;
    const t = text.trim();
    if (/^(?:mcq\s*practice|practice\s*instructions|end\s*practice|end\s*test|submit\s*test|score\s*:\s*\d+|questions?\s*attempted\s*:\s*\d+|time\s*left|timer\s*:|show\s*answer|skip|submit|next|previous)/i.test(t)) {
      return true;
    }
    if (/^(?:question\s*\d+\s*(?:of|\/)\s*\d+|q\s*\d+[\.\:\s]*)$/i.test(t)) {
      return true;
    }
    return false;
  }

  /**
   * Pure read-only DOM extraction function.
   * Performs ZERO mutations on the host page DOM.
   * 
   * @param {Object} customSelectors - User-specified CSS selectors.
   * @param {string} forcedQType - "auto" | "mcq" | "order" | "text"
   * @returns {Object} Extracted payload { success, subject, q_type, question, options, meta }
   */
  function extractQuizFromDom(customSelectors = {}, forcedQType = "auto") {
    const doc = (typeof document !== "undefined") ? document : null;
    if (!doc) {
      return { success: false, error: "No document object available for extraction." };
    }

    const custom = customSelectors || {};
    const matchedSelectors = {};

    // 1. EXTRACT SUBJECT
    let subject = "General";
    if (custom.subjectSelector) {
      const el = doc.querySelector(custom.subjectSelector);
      if (el && getCleanVisibleText(el)) {
        subject = getCleanVisibleText(el);
        matchedSelectors.subject = custom.subjectSelector;
      }
    }
    if (subject === "General") {
      // Check for topic headers like "MCQ PRACTICE | PROBABILITY RULES AND THEOREM"
      const titleMatches = doc.querySelectorAll("h1, h2, h3, h4, .quiz-title, header, .header, nav, [class*='header'], [class*='title']");
      for (const el of titleMatches) {
        if (isVisible(el)) {
          const txt = getCleanVisibleText(el);
          const topicMatch = txt.match(/(?:mcq\s*practice|practice|quiz|test|assessment)\s*[\|:\-]\s*([^\|:\n]+)/i);
          if (topicMatch && topicMatch[1]) {
            subject = cleanText(topicMatch[1]);
            matchedSelectors.subject = "practice-topic-header";
            break;
          }
        }
      }
    }
    if (subject === "General") {
      const subjectHeuristics = [
        "[data-quiz-subject]",
        ".quiz-subject",
        ".subject-title",
        "#quiz-subject",
        ".subject-name",
        "header .quiz-title",
        ".quiz-header h2",
        "header h2"
      ];
      for (const sel of subjectHeuristics) {
        const el = doc.querySelector(sel);
        if (el && isVisible(el) && getCleanVisibleText(el)) {
          subject = getCleanVisibleText(el);
          matchedSelectors.subject = sel;
          break;
        }
      }
    }

    // 2. EXTRACT QUESTION TEXT
    let question = "";
    if (custom.questionSelector) {
      const el = doc.querySelector(custom.questionSelector);
      if (el && getCleanVisibleText(el)) {
        question = getCleanVisibleText(el);
        matchedSelectors.question = custom.questionSelector;
      }
    }
    if (!question) {
      const questionHeuristics = [
        "[data-quiz-question]",
        ".question-text",
        ".quiz-question",
        ".question-title",
        "#question-text",
        "[role='heading'].question",
        "[class*='question-text']",
        "[class*='questionText']",
        "[class*='question_text']",
        ".question-card h2",
        ".question-container h3",
        ".question-container p",
        "h2.question",
        "h3.question",
        ".card-title"
      ];
      for (const sel of questionHeuristics) {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) {
          const txt = getCleanVisibleText(el);
          if (txt.length >= 8 && !isHeaderOrNavText(txt)) {
            question = txt;
            matchedSelectors.question = sel;
            break;
          }
        }
      }
    }

    // React card fallback: search within question container/card for problem statement
    if (!question) {
      const cardContainers = Array.from(doc.querySelectorAll(
        "[class*='question-card'], [class*='questionCard'], [class*='questionContainer'], [class*='question-container'], [class*='practice-card'], [class*='problem-card'], .card, main, [role='main'], form"
      )).filter(isVisible);

      for (const card of cardContainers) {
        const paragraphs = Array.from(card.querySelectorAll("p, div, h2, h3, h4, span")).filter(isVisible);
        for (const p of paragraphs) {
          // Avoid container if it contains radio option elements
          if (p.querySelector("input[type='radio'], [role='radio'], [class*='option']")) {
            continue;
          }
          const txt = getCleanVisibleText(p);
          if (txt.length >= 15 && !isHeaderOrNavText(txt)) {
            if (txt.includes("?") || /\b(?:probability|calculate|what is|which of the following|find|how many|determine|arrange|order|solve)\b/i.test(txt)) {
              question = txt;
              matchedSelectors.question = "react-card-paragraph";
              break;
            }
          }
        }
        if (question) break;
      }
    }

    // Secondary fallback for question if still empty: search headings
    if (!question) {
      const headings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, [role='heading']")).filter(isVisible);
      for (const h of headings) {
        const txt = getCleanVisibleText(h);
        if (txt.length >= 12 && !isHeaderOrNavText(txt) && !/quiz|test|exam|instructions/i.test(txt)) {
          question = txt;
          matchedSelectors.question = "heading-fallback";
          break;
        }
      }
    }

    // 3. EXTRACT OPTIONS & CLASSIFY QUESTION TYPE
    let options = [];
    let qType = forcedQType && forcedQType !== "auto" ? forcedQType : "auto";
    let isDraggableOrder = false;

    // Check for custom option elements
    let optionElements = [];
    if (custom.optionsSelector) {
      const found = Array.from(doc.querySelectorAll(custom.optionsSelector)).filter(isVisible);
      if (found.length > 0) {
        optionElements = found;
        matchedSelectors.options = custom.optionsSelector;
      }
    }

    // React / Web App Radio Row Detection
    if (optionElements.length === 0) {
      const radioInputs = Array.from(doc.querySelectorAll("input[type='radio']")).filter(isVisible);
      if (radioInputs.length >= 2 && radioInputs.length <= 10) {
        const radioRows = radioInputs.map((r) => {
          const lbl = r.closest("label") || (r.id ? doc.querySelector(`label[for="${r.id}"]`) : null);
          if (lbl && isVisible(lbl)) return lbl;
          const row = r.closest("[class*='option'], [class*='choice'], [class*='radio'], li, tr") || r.parentElement;
          return (row && isVisible(row)) ? row : r;
        });
        if (radioRows.length >= 2 && radioRows.length <= 10) {
          optionElements = radioRows;
          matchedSelectors.options = "input[type='radio']";
        }
      }
    }

    // Heuristics for options if not found via radio inputs
    if (optionElements.length === 0) {
      const optionGroupHeuristics = [
        "[data-quiz-option]",
        ".quiz-option",
        ".option-item",
        ".draggable-item",
        "[draggable='true']",
        "[role='option']",
        "[role='radio']",
        "[class*='radio-item']",
        "[class*='radioItem']",
        "[class*='option-item']",
        "[class*='optionItem']",
        "[class*='choice-item']",
        "[class*='choiceItem']",
        ".quiz-choice",
        ".option-card",
        "li.choice",
        ".order-item",
        ".sortable-block",
        "[role='radiogroup'] > *",
        "ul[class*='option'] > li",
        "ol[class*='option'] > li"
      ];

      for (const sel of optionGroupHeuristics) {
        const matches = Array.from(doc.querySelectorAll(sel)).filter(isVisible);
        if (matches.length >= 2 && matches.length <= 10) {
          optionElements = matches;
          matchedSelectors.options = sel;
          break;
        }
      }
    }

    // Check if option elements indicate drag-and-drop / ordering
    if (optionElements.length > 0) {
      isDraggableOrder = optionElements.some((el) => {
        const isDrag = el.getAttribute("draggable") === "true" || el.draggable === true;
        const className = String(el.className || "").toLowerCase();
        const hasDragClass = className.includes("drag") || className.includes("sort") || className.includes("order");
        return isDrag || hasDragClass;
      });

      options = optionElements.map((el) => {
        const raw = getCleanVisibleText(el);
        const stripped = stripDecorativePrefix(raw);
        return stripped || raw;
      }).filter((t) => t.length > 0);
    }

    // Check for free text input
    let textInputEl = null;
    if (custom.textInputSelector) {
      textInputEl = doc.querySelector(custom.textInputSelector);
    }
    if (!textInputEl) {
      const inputHeuristics = [
        "[data-quiz-input]",
        "input.quiz-input",
        "input.fill-blank",
        "textarea.quiz-input",
        ".question-container input[type='text']",
        ".question-container textarea",
        "input[type='text']:not([aria-hidden='true'])",
        "textarea:not([aria-hidden='true'])"
      ];
      for (const sel of inputHeuristics) {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) {
          textInputEl = el;
          matchedSelectors.textInput = sel;
          break;
        }
      }
    }

    // 4. RESOLVE QUESTION TYPE
    if (forcedQType !== "auto") {
      qType = forcedQType;
    } else {
      if (options.length === 0 && textInputEl) {
        qType = "text";
      } else if (options.length >= 2) {
        const orderKeywordRegex = /\b(arrange|order|sequence|chronological|sort|first to last|earliest to latest|rank)\b/i;
        if (isDraggableOrder || orderKeywordRegex.test(question)) {
          qType = "order";
        } else {
          qType = "mcq";
        }
      } else if (textInputEl) {
        qType = "text";
      } else {
        qType = "mcq";
      }
    }

    // Validation
    if (!question) {
      return {
        success: false,
        error: "Unable to detect quiz question. Please specify a Question Selector in Settings or enter it manually."
      };
    }

    if (qType in { mcq: 1, order: 1 } && options.length < 2) {
      if (textInputEl) {
        qType = "text";
      } else {
        return {
          success: false,
          error: `Question type is '${qType}' but only ${options.length} options were found. Please configure Options Selector in Settings.`,
          partial: { subject, q_type: qType, question, options }
        };
      }
    }

    return {
      success: true,
      subject: subject || "General",
      q_type: qType,
      question: question,
      options: options,
      meta: {
        url: (typeof window !== "undefined" && window.location) ? window.location.href : "",
        timestamp: Date.now(),
        matched_selectors: matchedSelectors,
        options_count: options.length
      }
    };
  }

  /**
   * Opt-In DOM Highlighter.
   * NEVER runs automatically or by default.
   * ONLY runs if the user explicitly enables "Opt-In Page DOM Highlight" in the Side Panel.
   * 
   * @param {Object} payload - { remove?: boolean, selected_index?: number, customSelectors?: Object }
   */
  function applyDomHighlight(payload = {}) {
    if (typeof document === "undefined") return { success: false, error: "No document" };

    const STYLE_ID = "quizzy-optin-highlight-styles";
    const WINNER_CLASS = "quizzy-optin-winner";

    // 1. Remove previous highlights
    const existingStyle = document.getElementById(STYLE_ID);
    if (existingStyle) {
      existingStyle.remove();
    }
    const previousElements = document.querySelectorAll("." + WINNER_CLASS);
    previousElements.forEach((el) => {
      el.classList.remove(WINNER_CLASS);
    });

    if (payload.remove) {
      return { success: true, removed: true };
    }

    // 2. Inject high-contrast non-destructive outline CSS
    const styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = `
      .${WINNER_CLASS} {
        outline: 3px solid #22C55E !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 14px rgba(34, 197, 94, 0.45) !important;
        transition: outline 0.2s ease, box-shadow 0.2s ease !important;
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);

    // 3. Highlight targeted option index if specified
    if (typeof payload.selected_index === "number" && payload.selected_index >= 0) {
      let optionElements = [];
      if (payload.customSelectors && payload.customSelectors.optionsSelector) {
        optionElements = Array.from(document.querySelectorAll(payload.customSelectors.optionsSelector)).filter(isVisible);
      }
      if (optionElements.length === 0) {
        const selectors = [
          "[data-quiz-option]",
          ".quiz-option",
          ".option-item",
          ".draggable-item",
          "[draggable='true']",
          "[role='option']",
          "[role='radio']",
          ".quiz-choice"
        ];
        for (const sel of selectors) {
          const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          if (matches.length > payload.selected_index) {
            optionElements = matches;
            break;
          }
        }
      }

      if (optionElements[payload.selected_index]) {
        optionElements[payload.selected_index].classList.add(WINNER_CLASS);
        return { success: true, highlighted_index: payload.selected_index };
      }
    }

    return { success: true, highlighted: false };
  }

  // Export to window for Chrome extension scripting and module for Node testing
  const QuizZyExtractor = {
    cleanText,
    stripDecorativePrefix,
    isVisible,
    getCleanVisibleText,
    isHeaderOrNavText,
    extractQuizFromDom,
    applyDomHighlight
  };

  if (typeof window !== "undefined") {
    window.QuizZyExtractor = QuizZyExtractor;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = QuizZyExtractor;
  }
})();
