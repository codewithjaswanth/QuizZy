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
   * Normalizes common LaTeX mathematical notation into clean readable ASCII.
   * e.g. \frac{1}{6} -> 1/6, \times -> *, x^{2} -> x^2, \pm -> +/-
   */
  function normalizeTeX(tex) {
    if (!tex) return "";
    let s = String(tex).trim();

    // 1. Convert \frac{a}{b} and \dfrac{a}{b} -> a/b
    let prev;
    do {
      prev = s;
      s = s.replace(/\\d?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "($1)/($2)");
      s = s.replace(/\\d?frac\s*([0-9a-zA-Z])\s*([0-9a-zA-Z])/g, "$1/$2");
    } while (s !== prev);

    // Clean up unnecessary parentheses around single terms in fractions, e.g. (1)/(6) -> 1/6
    s = s.replace(/\(([0-9a-zA-Z]+)\)\/\(([0-9a-zA-Z]+)\)/g, "$1/$2");
    s = s.replace(/\(([0-9a-zA-Z]+)\)\/([0-9a-zA-Z]+)/g, "$1/$2");
    s = s.replace(/([0-9a-zA-Z]+)\/\(([0-9a-zA-Z]+)\)/g, "$1/$2");

    // 2. Common operators & symbols
    s = s.replace(/\\times\b/g, " * ")
         .replace(/\\cdot\b/g, " * ")
         .replace(/\\div\b/g, " / ")
         .replace(/\\pm\b/g, " +/- ")
         .replace(/\\mp\b/g, " -/+ ")
         .replace(/\\neq\b/g, " != ")
         .replace(/\\leq\b/g, " <= ")
         .replace(/\\geq\b/g, " >= ")
         .replace(/\\approx\b/g, " approx ")
         .replace(/\\infty\b/g, " infinity ")
         .replace(/\\pi\b/g, " pi ")
         .replace(/\\sqrt\s*\{([^{}]+)\}/g, "sqrt($1)")
         .replace(/\\sqrt\s*([0-9a-zA-Z])/g, "sqrt($1)");

    // 3. Superscripts and subscripts: ^{n} -> ^n, _{n} -> _n
    s = s.replace(/\^\{([^{}]+)\}/g, "^$1")
         .replace(/\_\{([^{}]+)\}/g, "_$1");

    // 4. Formatting commands: \text{...}, \mathbf{...}, \mathit{...}, \mathrm{...}
    s = s.replace(/\\(?:text|mathbf|mathit|mathrm|mathbb|mathcal)\s*\{([^{}]+)\}/g, "$1");

    // 5. Clean delimiters: \left, \right
    s = s.replace(/\\(?:left|right)\b/g, "");

    // 6. Clean escaped symbols: \% -> %, \$ -> $, \_ -> _
    s = s.replace(/\\([%$&_#{}\\])/g, "$1");

    // 7. Strip remaining TeX command words, remove leftover braces, collapse spaces
    s = s.replace(/\\[a-zA-Z]+/g, " ")
         .replace(/[\{\}]/g, "")
         .replace(/\s+/g, " ")
         .trim();

    return s;
  }

  /**
   * Strips decorative leading bullets/letters (e.g. 'A.', '1)', '(a)')
   * while strictly preserving decimals ('1.5'), ratios ('1:6'), fractions ('1/6', '2/36'),
   * negatives ('-1/6'), and single character options ('0', 'A').
   */
  function stripDecorativePrefix(text) {
    if (!text) return "";
    let s = String(text).trim();

    // 1. Parenthesized prefix: (A) 1/6, (1) text, (iv) option
    s = s.replace(/^\(\s*[A-Za-z0-9]{1,3}\s*\)\s+/, "");

    // 2. Letter prefix followed by . or ) or : or - and whitespace: 'A. foo', 'b) bar', 'C - baz', 'D: qux'
    // Requires trailing whitespace (\s+) so 'A.B' or single letter 'A' is preserved
    s = s.replace(/^[A-Za-z]\s*[\.\)\:\-]\s+/, "");

    // 3. Digit prefix 1-999 followed by . or ) or - and whitespace:
    // CRITICAL: NEVER match if followed by a digit (preserves '1.5' -> '1.5')
    // and NEVER use ':' as prefix delimiter for numbers (preserves '1:6' -> '1:6')
    s = s.replace(/^[0-9]{1,3}\s*(?:\)|-(?!\d)|\.(?!\d))\s+/, "");

    // 4. Bullet symbols followed by whitespace
    s = s.replace(/^[\u2022\u25E6\u25AA\u2023]\s+/, "");

    return s.trim();
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
   * Extracts clean visible text while reading raw TeX from KaTeX/MathJax annotations
   * or normalizing KaTeX visual HTML fallback, ignoring hidden/duplicate elements (ZERO DOM MUTATION).
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

      // Check inline display:none or visibility:hidden
      const styleAttr = (node.getAttribute && node.getAttribute("style")) || "";
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(styleAttr)) {
        return "";
      }
      if (node.hasAttribute && node.hasAttribute("hidden")) {
        return "";
      }

      const cls = typeof node.className === "string" ? node.className : ((node.getAttribute && node.getAttribute("class")) || "");

      // Check for KaTeX or MathJax container
      const isKatexContainer = cls.includes("katex") && !cls.includes("katex-html") && !cls.includes("katex-mathml");
      const isMathJaxContainer = tag === "mjx-container" || cls.includes("MathJax") || tag === "math";

      if (isKatexContainer || isMathJaxContainer) {
        // 1. Look for <annotation encoding="application/x-tex">, <annotation>, data-latex, or alttext
        const annotation = node.querySelector ? node.querySelector("annotation[encoding*='tex'], annotation") : null;
        let rawTex = annotation ? (annotation.textContent || annotation.innerText) : null;

        if (!rawTex && node.getAttribute) {
          rawTex = node.getAttribute("data-latex") || node.getAttribute("alttext") || node.getAttribute("aria-label");
        }

        if (rawTex && rawTex.trim()) {
          return " " + normalizeTeX(rawTex) + " ";
        }

        // 2. Fallback: inspect .katex-html structure for .mfrac / .frac-line
        const katexHtml = node.querySelector ? node.querySelector(".katex-html") : (cls.includes("katex-html") ? node : null);
        if (katexHtml) {
          const mfrac = katexHtml.querySelector ? katexHtml.querySelector(".mfrac") : null;
          if (mfrac) {
            const vlists = mfrac.querySelectorAll(".vlist > span");
            if (vlists.length >= 2) {
              const numText = cleanText(vlists[0].textContent || "");
              const denText = cleanText(vlists[vlists.length - 1].textContent || "");
              if (numText && denText) {
                return " " + numText + "/" + denText + " ";
              }
            }
          }
        }
      }

      // Filter out KaTeX/MathJax duplicate assistive MathML or TeX annotations if encountered standalone
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

      // KaTeX puts aria-hidden="true" on .katex-html, but that is the real visual math we want!
      const ariaHidden = node.getAttribute ? node.getAttribute("aria-hidden") : null;
      if (ariaHidden === "true" && !cls.includes("katex-html") && !(node.closest && node.closest(".katex-html"))) {
        if (tag === "svg" || tag === "i" || tag === "img" || cls.includes("icon")) {
          return "";
        }
      }

      // Skip radio/checkbox inputs from contributing raw value text
      if (tag === "input" && (node.type === "radio" || node.type === "checkbox")) {
        return "";
      }

      // In KaTeX HTML fallback, if we encounter .msupsub, handle superscript/subscript prefix
      if (cls.includes("msupsub")) {
        const vlist = node.querySelector ? node.querySelector(".vlist") : null;
        if (vlist) {
          const text = cleanText(vlist.textContent || "");
          if (text) {
            return "^" + text;
          }
        }
      }

      let text = "";
      if (node.childNodes && node.childNodes.length > 0) {
        for (let i = 0; i < node.childNodes.length; i++) {
          text += walk(node.childNodes[i]);
        }
      } else {
        for (let child = node.firstChild; child; child = child.nextSibling) {
          text += walk(child);
        }
      }
      return text;
    }

    return cleanText(walk(el));
  }

  /**
   * Identifies non-question header, navigation, button, or explanation strings to prevent false positives.
   */
  function isHeaderOrNavText(text) {
    if (!text) return true;
    const t = text.trim();

    // Top-bar navigation, controls, scores, instructions
    if (/^(?:mcq\s*practice|practice\s*instructions|end\s*practice|end\s*test|submit\s*test|score\s*:\s*\d+|questions?\s*attempted\s*:\s*\d+|time\s*left|timer\s*:|show\s*answer|skip|submit|next|previous|back|continue|report(?:\s*an)?\s*issue)/i.test(t)) {
      return true;
    }

    // Post-submit explanation or feedback title headers
    if (t.length <= 40 && /^(?:explanation|solution|correct\s*answer|your\s*answer|detailed\s*solution|answer\s*key|hint|review(?:\s*questions)?)/i.test(t)) {
      return true;
    }

    // Numbering artifacts like "Question 1 of 15" or "Q1."
    if (/^(?:question\s*\d+\s*(?:of|\/)\s*\d+|q\s*\d+[\.\:\s]*)$/i.test(t)) {
      return true;
    }

    return false;
  }

  /**
   * Checks if an element is part of a post-submit explanation or feedback container.
   */
  function isExplanationOrFeedback(el) {
    if (!el) return false;
    const cls = typeof el.className === "string" ? el.className.toLowerCase() : ((el.getAttribute && el.getAttribute("class")) || "").toLowerCase();
    const id = typeof el.id === "string" ? el.id.toLowerCase() : ((el.getAttribute && el.getAttribute("id")) || "").toLowerCase();
    if (/explanation|solution|feedback|correct-answer|answer-key|hint-drawer|review-box/.test(cls + " " + id)) {
      return true;
    }
    const heading = el.querySelector ? el.querySelector("h1, h2, h3, h4, h5, h6, strong, .title") : null;
    if (heading && isHeaderOrNavText(heading.textContent || heading.innerText || "")) {
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

    // 2. EXTRACT QUESTION TEXT (Supports multi-block, code snippets, declarative prompts, ignores explanations)
    let question = "";
    if (custom.questionSelector) {
      const el = doc.querySelector(custom.questionSelector);
      if (el && getCleanVisibleText(el)) {
        question = getCleanVisibleText(el);
        matchedSelectors.question = custom.questionSelector;
      }
    }

    // React card search: search question containers for multi-block stems (prompts + <pre><code>)
    if (!question) {
      const cardContainers = Array.from(doc.querySelectorAll(
        "[class*='question-card'], [class*='questionCard'], [class*='questionContainer'], [class*='question-container'], [class*='quiz-card'], [class*='quizCard'], [class*='quiz-container'], [class*='quizContainer'], [class*='practice-card'], [class*='problem-card'], [class*='mcq-card'], [class*='card'], .card, main, [role='main'], form"
      )).filter(isVisible);

      for (const card of cardContainers) {
        if (isExplanationOrFeedback(card)) continue;

        const stemElements = Array.from(card.querySelectorAll("p, pre, code, table, h2, h3, h4, [class*='question']")).filter(isVisible);
        const stemParts = [];

        for (const el of stemElements) {
          // Avoid elements inside option lists, radio groups, buttons, top-bars, or explanation drawers
          if (el.closest && (el.closest("[class*='option'], [class*='choice'], [class*='radio'], label, button, .react-top-bar, footer") || isExplanationOrFeedback(el))) {
            continue;
          }
          if (el.querySelector && el.querySelector("input[type='radio'], [role='radio'], [class*='option']")) {
            continue;
          }

          const tag = el.tagName.toLowerCase();
          if (tag === "pre" || tag === "code") {
            const codeText = (el.textContent || el.innerText || "").trim();
            if (codeText && !stemParts.includes(codeText)) {
              stemParts.push(codeText);
            }
          } else {
            const txt = getCleanVisibleText(el);
            if (txt.length >= 10 && !isHeaderOrNavText(txt) && !stemParts.some(p => p.includes(txt))) {
              stemParts.push(txt);
            }
          }
        }

        if (stemParts.length > 0) {
          question = stemParts.join("\n\n").trim();
          matchedSelectors.question = "card-stem-multiblock";
          break;
        }
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
        "[class*='question-stem']",
        "[class*='questionStem']",
        "[class*='question-body']",
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
        if (el && isVisible(el) && !isExplanationOrFeedback(el)) {
          const txt = getCleanVisibleText(el);
          if (txt.length >= 8 && !isHeaderOrNavText(txt)) {
            const nextEl = el.nextElementSibling;
            if (nextEl && (nextEl.tagName.toLowerCase() === "pre" || nextEl.tagName.toLowerCase() === "code")) {
              const codeTxt = (nextEl.textContent || nextEl.innerText || "").trim();
              question = txt + "\n\n" + codeTxt;
            } else {
              question = txt;
            }
            matchedSelectors.question = sel;
            break;
          }
        }
      }
    }

    // Secondary fallback for question if still empty: search headings
    if (!question) {
      const headings = Array.from(doc.querySelectorAll("h1, h2, h3, h4, [role='heading']")).filter(isVisible);
      for (const h of headings) {
        if (isExplanationOrFeedback(h)) continue;
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
