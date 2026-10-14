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
   * e.g. \frac{1}{6} -> 1/6, \frac{2^{3}}{6} -> 2^3/6, \frac{n+1}{2} -> (n+1)/2
   */
  function normalizeTeX(tex) {
    if (!tex) return "";
    let s = String(tex).trim();

    // 1. First normalize inner constructs (exponents, subscripts, roots, text formatting)
    // in a loop up to 4 passes so nested braces inside numerators/denominators are flattened first
    for (let pass = 0; pass < 4; pass++) {
      const before = s;
      s = s.replace(/\\(?:left|right)\b/g, "")
           .replace(/\^\{([^{}]+)\}/g, "^$1")
           .replace(/\_\{([^{}]+)\}/g, "_$1")
           .replace(/\\sqrt\s*\{([^{}]+)\}/g, "sqrt($1)")
           .replace(/\\sqrt\s*([0-9a-zA-Z])/g, "sqrt($1)")
           .replace(/\\(?:text|mathbf|mathit|mathrm|mathbb|mathcal)\s*\{([^{}]+)\}/g, "$1");
      if (s === before) break;
    }

    // 2. Convert \frac{num}{den} and \dfrac{num}{den}
    // If num or den has compound operators (+ or -), wrap in parentheses: (n+1)/2 or 1/(n-1)
    for (let pass = 0; pass < 4; pass++) {
      const before = s;
      s = s.replace(/\\d?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (match, num, den) => {
        let n = num.trim();
        let d = den.trim();
        if (/[+\-]/.test(n) && !/^\(.*\)$/.test(n)) {
          n = `(${n})`;
        }
        if (/[+\-]/.test(d) && !/^\(.*\)$/.test(d)) {
          d = `(${d})`;
        }
        return `${n}/${d}`;
      });
      s = s.replace(/\\d?frac\s*([0-9a-zA-Z])\s*([0-9a-zA-Z])/g, "$1/$2");
      if (s === before) break;
    }


    // 3. Common operators & symbols
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
         .replace(/\\pi\b/g, " pi ");

    // 4. Clean escaped symbols: \% -> %, \$ -> $, \_ -> _
    s = s.replace(/\\([%$&_#{}\\])/g, "$1");

    // 5. Strip remaining TeX command words, remove leftover braces, collapse spaces
    s = s.replace(/\\[a-zA-Z]+/g, " ")
         .replace(/[\{\}]/g, "")
         .replace(/\s+/g, " ")
         .trim();

    return s;
  }

  /**
   * Strips decorative leading bullets/letters (e.g. 'A.', '1)', '(A)')
   * while strictly preserving algebra/subtraction ('1 - 1/6', '1 - P(A)', 'A - B', 'n - 1'),
   * ratios ('1:6', 'A : B', 'x : y'), decimals ('1.5', '0.25'), fractions ('1/6', '2/36'),
   * negatives ('-1/6'), and single character options ('0', 'A').
   */
  function stripDecorativePrefix(text) {
    if (!text) return "";
    let s = String(text).trim();

    // 1. Parenthesized/bracketed prefix: (A) 1/6, [B] option, (1) text
    s = s.replace(/^(?:\(\s*[A-Fa-f0-9]{1,2}\s*\)|\[\s*[A-Fa-f0-9]{1,2}\s*\])\s+/, "");

    // 2. Letter prefix [A-Fa-f] followed immediately by . or ) or : and whitespace:
    // e.g., 'A. foo', 'b) bar', 'C: baz'
    // Requires immediate attachment (no space before delimiter) and trailing whitespace (\s+)
    // to strictly preserve 'A : B', 'A - B', 'x : y', and single letter 'A'
    s = s.replace(/^[A-Fa-f][\.\)\:]\s+/, "");

    // 3. Digit prefix 1-99 followed immediately by . or ) and whitespace:
    // e.g., '1. 1/6', '2) option'
    // NEVER allow '-' or ':' as numeric delimiter (preserves '1 - 1/6', '1 - P(A)', '10 - 2', '1:6')
    // and requires trailing whitespace (preserves '1.5', '0.25')
    s = s.replace(/^[0-9]{1,2}[\.\)]\s+/, "");

    // 4. Bullet symbols followed by whitespace
    s = s.replace(/^[\u2022\u25E6\u25AA\u2023]\s+/, "");

    return s.trim();
  }

  /**
   * Preserves multi-line indentation for code blocks while collapsing standard prose/math options.
   * Strips decorative prefixes only on the first line.
   */
  function normalizeOptionWhitespace(text, hasCodeBlock) {
    if (!text) return "";
    const clean = String(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");

    const isMultiLineCode = hasCodeBlock && clean.includes("\n");
    if (isMultiLineCode) {
      const lines = clean.split("\n");
      while (lines.length > 0 && lines[0].trim() === "") lines.shift();
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      if (lines.length === 0) return "";

      lines[0] = stripDecorativePrefix(lines[0]);
      return lines.join("\n");
    }

    const single = clean.replace(/\s+/g, " ").trim();
    return stripDecorativePrefix(single);
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
      } catch (e) {}
    }
    return true;
  }

  /**
   * Helper that checks if either the radio input or its container label/card is visible.
   * Crucial for React apps where <input type="radio"> is hidden via CSS while its <label> is visible.
   */
  function isRadioOrOptionVisible(radioEl, containerEl) {
    if (radioEl && isVisible(radioEl)) return true;
    if (containerEl && isVisible(containerEl)) return true;
    return false;
  }

  /**
   * Math-Safe Text Reader:
   * Extracts clean visible text while reading raw TeX from KaTeX/MathJax annotations
   * or normalizing KaTeX visual HTML fallback, ignoring hidden/duplicate elements (ZERO DOM MUTATION).
   */
  function getCleanVisibleText(el, preserveWhitespace = false) {
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
      if (tag === "br") {
        return "\n";
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

    const rawWalk = walk(el);
    if (preserveWhitespace) {
      return String(rawWalk)
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
    }
    return cleanText(rawWalk);
  }

  /**
   * Identifies non-question header, navigation, button, or explanation strings to prevent false positives.
   */
  function isHeaderOrNavText(text) {
    if (!text) return true;
    const t = text.trim();

    // Top-bar navigation, controls, scores, instructions, CCBP student ID & disclaimers
    if (/^(?:mcq\s*practice|practice\s*instructions|end\s*practice|end\s*test|submit\s*test|score\s*:\s*\d+|questions?\s*attempted\s*:\s*\d+|time\s*left|timer\s*:|show\s*answer|skip|submit|next|next\s*question|previous|back|continue|report(?:\s*an)?\s*issue|id\s*:\s*|if\s*you\s*skip)/i.test(t)) {
      return true;
    }

    if (/if\s+you\s+skip,\s+you\s+can\s+attempt\s+this\s+question\s+again/i.test(t)) {
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
   * Walks up the ancestor chain and inspects container classes, IDs, headings, and sibling headings.
   */
  function isExplanationOrFeedback(el) {
    if (!el) return false;
    // Interactive action buttons (SHOW ANSWER, SUBMIT, SKIP, etc.) are NOT explanation boxes
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "button" || tag === "input") {
      return false;
    }

    const doc = (typeof document !== "undefined") ? document : null;
    const stopNode = doc ? doc.body : null;

    const classIdPattern = /\b(explanation|solution|feedback|answer-key|hint-box|hint-drawer|correct-answer|result-drawer|review-box)\b/i;
    const headingPattern = /^\s*(?:explanation|solution|correct\s*answer|your\s*answer|hint|note\s*:|answer\s*:)/i;

    let curr = el;
    while (curr && curr !== stopNode && curr.nodeType === 1) {
      const currTag = (curr.tagName || "").toLowerCase();
      if (currTag === "button") {
        curr = curr.parentElement;
        continue;
      }

      // 1. Check id and className on curr
      const cls = typeof curr.className === "string" ? curr.className : ((curr.getAttribute && curr.getAttribute("class")) || "");
      const id = typeof curr.id === "string" ? curr.id : ((curr.getAttribute && curr.getAttribute("id")) || "");
      if (classIdPattern.test(cls) || classIdPattern.test(id)) {
        return true;
      }

      // 2. Check if curr's first element child is a heading that identifies an explanation section
      const firstChild = curr.firstElementChild || (curr.children && curr.children[0]);
      if (firstChild) {
        const fcTag = (firstChild.tagName || "").toLowerCase();
        if (fcTag !== "button" && /^h[1-6]$|strong|b|span|div/.test(fcTag)) {
          const fcText = cleanText(firstChild.textContent || firstChild.innerText || "");
          if (headingPattern.test(fcText) && !/show\s*answer/i.test(fcText)) {
            return true;
          }
        }
      }

      // 3. Check curr's previous element sibling if it was a heading for an explanation section
      if (curr.previousElementSibling) {
        const prevTag = (curr.previousElementSibling.tagName || "").toLowerCase();
        if (prevTag !== "button" && /^h[1-6]$|strong|b/.test(prevTag)) {
          const prevText = cleanText(curr.previousElementSibling.textContent || curr.previousElementSibling.innerText || "");
          if (headingPattern.test(prevText) && !/show\s*answer/i.test(prevText)) {
            return true;
          }
        }
      }

      curr = curr.parentElement;
    }

    return false;
  }

  /**
   * Finds the Quiz Card container.
   * Supports semantic card classes, button-anchored cards (for classless styled-components), and generic main/form/card elements.
   */
  function findQuizCard(doc) {
    if (!doc) return null;

    // 1. Semantic card classes
    const semanticSelectors = [
      "[class*='question-card']", "[class*='questionCard']",
      "[class*='questionContainer']", "[class*='question-container']",
      "[class*='quiz-card']", "[class*='quizCard']",
      "[class*='quiz-container']", "[class*='quizContainer']",
      "[class*='practice-card']", "[class*='problem-card']",
      "[class*='mcq-card']"
    ];
    for (const sel of semanticSelectors) {
      const found = Array.from(doc.querySelectorAll(sel)).filter(isVisible);
      for (const el of found) {
        if (!isExplanationOrFeedback(el)) return el;
      }
    }

    // 2. Button-anchored discovery (for styled-components / sc-...)
    const buttons = Array.from(doc.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")).filter(isVisible);
    let actionBtn = null;
    for (const btn of buttons) {
      const txt = cleanText(btn.textContent || btn.value || "");
      if (/^(?:submit|show\s*answer|next\s*question|next|check|skip)$/i.test(txt)) {
        actionBtn = btn;
        if (/^(?:submit|show\s*answer)$/i.test(txt)) break;
      }
    }

    if (actionBtn) {
      let curr = actionBtn.parentElement;
      let candidateCard = null;
      while (curr && curr !== doc.body && curr !== doc.documentElement) {
        const currText = curr.textContent || "";
        // Stop before the top navbar that encloses the whole page
        if (/mcq\s*practice|end\s*practice|questions?\s*attempted/i.test(currText)) {
          break;
        }

        // Substantial container enclosing content above buttons
        if (curr.children && curr.children.length >= 2) {
          candidateCard = curr;
        }

        curr = curr.parentElement;
      }

      if (candidateCard) {
        return candidateCard;
      }
    }

    // 3. Fallbacks
    const generic = Array.from(doc.querySelectorAll("main, [role='main'], form, .card")).filter(isVisible);
    for (const el of generic) {
      if (!isExplanationOrFeedback(el)) return el;
    }

    return null;
  }

  /**
   * Classless Option Group Discovery (for styled-components / sc-... without radio inputs or semantic classes).
   */
  function findClasslessOptionElements(scopeRoot, docRef) {
    const scope = scopeRoot || docRef || (typeof document !== "undefined" ? document : null);
    if (!scope) return [];

    const actionButtons = Array.from(scope.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")).filter(isVisible);
    let actionBoundary = null;
    for (const btn of actionButtons) {
      const txt = cleanText(btn.textContent || btn.value || "");
      if (/^(?:submit|show\s*answer|next\s*question|next|check|skip|end\s*practice)$/i.test(txt)) {
        actionBoundary = btn;
        break;
      }
    }

    const candidateContainers = Array.from(scope.querySelectorAll("div, ul, ol")).filter(isVisible);
    for (let i = candidateContainers.length - 1; i >= 0; i--) {
      const container = candidateContainers[i];
      if (container === scope) continue;
      if (actionBoundary && container.contains && container.contains(actionBoundary)) continue;

      const children = Array.from(container.children || []).filter(isVisible);
      if (children.length < 2 || children.length > 6) continue;

      const firstTag = (children[0].tagName || "").toLowerCase();
      if (!["div", "li", "button", "label", "span"].includes(firstTag)) continue;
      const allSameTag = children.every(c => (c.tagName || "").toLowerCase() === firstTag);
      if (!allSameTag) continue;

      const hasActionBtn = children.some(c => {
        const txt = cleanText(c.textContent || "");
        return /^(?:show\s*answer|submit|skip|next\s*question|next|end\s*practice|practice\s*instructions)$/i.test(txt);
      });
      if (hasActionBtn) continue;

      const texts = children.map(c => getCleanVisibleText(c));
      const validTexts = texts.every(t => t.length >= 1 && t.length <= 300 && !isHeaderOrNavText(t));
      if (!validTexts) continue;

      const uniqueTexts = new Set(texts);
      if (uniqueTexts.size < 2) continue;

      return children;
    }

    return [];
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
      // Check for topic headers like "MCQ PRACTICE | PROBABILITY RULES AND THEOREM" (with or without space after |)
      const titleMatches = doc.querySelectorAll("h1, h2, h3, h4, .quiz-title, header, .header, nav, [class*='header'], [class*='title'], div, span, p");
      for (const el of titleMatches) {
        if (isVisible(el)) {
          const txt = getCleanVisibleText(el);
          const topicMatch = txt.match(/mcq\s*practice\s*\|\s*([^\n\r\t]+)/i) ||
                             txt.match(/(?:mcq\s*practice|practice|quiz|test|assessment)\s*[\|:\-]\s*([^\n\r\t]+)/i);
          if (topicMatch && topicMatch[1]) {
            let rawTopic = topicMatch[1].trim();
            rawTopic = rawTopic.replace(/\s*(?:score\s*:|questions?\s*attempted|practice\s*instructions|end\s*practice|id\s*:).*$/i, "");
            rawTopic = cleanText(rawTopic);
            if (rawTopic.length >= 2) {
              subject = rawTopic;
              matchedSelectors.subject = "practice-topic-header";
              break;
            }
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

    // 2. DISCOVER CARD CONTAINER AND OPTIONS
    const quizCard = findQuizCard(doc);

    let options = [];
    let qType = forcedQType && forcedQType !== "auto" ? forcedQType : "auto";
    let isDraggableOrder = false;
    let optionElements = [];
    if (custom.optionsSelector) {
      const found = Array.from(doc.querySelectorAll(custom.optionsSelector)).filter(isVisible);
      if (found.length > 0) {
        optionElements = found;
        matchedSelectors.options = custom.optionsSelector;
      }
    }

    // React / Web App Radio Row Detection
    // Supports CSS-hidden <input type="radio"> (e.g. display:none or opacity:0) with visible label/card wrappers
    if (optionElements.length === 0) {
      const allRadios = Array.from(doc.querySelectorAll("input[type='radio']"));
      const validRows = [];
      for (const r of allRadios) {
        const lbl = r.closest("label") || (r.id ? doc.querySelector(`label[for="${r.id}"]`) : null);
        const row = lbl || r.closest("[class*='option'], [class*='choice'], [class*='radio'], li, tr") || r.parentElement;
        if (isRadioOrOptionVisible(r, row)) {
          validRows.push(row || r);
        }
      }
      if (validRows.length >= 2 && validRows.length <= 10) {
        optionElements = validRows;
        matchedSelectors.options = "input[type='radio']";
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

    // Classless styled-components option group discovery (e.g. learning.ccbp.in)
    if (optionElements.length === 0) {
      const classless = findClasslessOptionElements(quizCard || doc, doc);
      if (classless.length >= 2) {
        optionElements = classless;
        matchedSelectors.options = "classless-styled-options";
      }
    }

    // 3. EXTRACT QUESTION TEXT (Supports multi-block, code snippets, declarative prompts, ignores explanations)
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
      const cardContainers = (quizCard ? [quizCard] : Array.from(doc.querySelectorAll(
        "[class*='question-card'], [class*='questionCard'], [class*='questionContainer'], [class*='question-container'], [class*='quiz-card'], [class*='quizCard'], [class*='quiz-container'], [class*='quizContainer'], [class*='practice-card'], [class*='problem-card'], [class*='mcq-card'], [class*='card'], .card, main, [role='main'], form"
      ))).filter(isVisible);

      for (const card of cardContainers) {
        if (isExplanationOrFeedback(card)) continue;

        const allDescendants = Array.from(card.querySelectorAll("*"));
        const firstOpt = (optionElements && optionElements.length > 0) ? optionElements[0] : null;
        const firstOptIndex = firstOpt ? allDescendants.indexOf(firstOpt) : -1;
        const hrEl = card.querySelector("hr");
        const hrIndex = hrEl ? allDescendants.indexOf(hrEl) : -1;

        const stemCandidates = Array.from(card.querySelectorAll("p, pre, code, table, h2, h3, h4, div, span, [class*='question']")).filter(isVisible);
        const stemParts = [];

        for (const el of stemCandidates) {
          const elIdx = allDescendants.indexOf(el);
          if (firstOptIndex !== -1 && elIdx >= firstOptIndex) continue;
          if (hrIndex !== -1 && elIdx >= hrIndex) continue;
          if (firstOpt && el.contains && el.contains(firstOpt)) continue;

          // Avoid elements inside option lists, radio groups, buttons, top-bars, or explanation drawers
          if (el.closest && (el.closest("[class*='option'], [class*='choice'], [class*='radio'], label, button, .react-top-bar, footer") || isExplanationOrFeedback(el))) {
            continue;
          }
          if (el.tagName && el.tagName.toLowerCase() === "button") continue;
          if (el.querySelector && el.querySelector("input[type='radio'], [role='radio'], [class*='option'], button")) {
            continue;
          }

          const tag = el.tagName.toLowerCase();
          if (tag === "code" && el.closest && el.closest("pre")) {
            // Skip inner <code> if parent <pre> exists to avoid duplicate extraction
            continue;
          }
          if (tag === "pre" || tag === "code") {
            const rawCode = (el.textContent || el.innerText || "");
            const cleanCode = rawCode
              .replace(/[\u200B-\u200D\uFEFF]/g, "")
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n");
            const lines = cleanCode.split("\n");
            while (lines.length > 0 && lines[0].trim() === "") lines.shift();
            while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
            const formattedCode = lines.join("\n");
            if (formattedCode && !stemParts.includes(formattedCode)) {
              stemParts.push(formattedCode);
            }
          } else {
            const hasBlockChildren = el.querySelector("p, h1, h2, h3, h4, pre, code, table");
            if (hasBlockChildren) continue;

            const txt = getCleanVisibleText(el);
            if (txt.length >= 8 && !isHeaderOrNavText(txt) && !stemParts.some(p => p.includes(txt))) {
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
              const rawCode = (nextEl.textContent || nextEl.innerText || "")
                .replace(/[\u200B-\u200D\uFEFF]/g, "")
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "\n");
              const lines = rawCode.split("\n");
              while (lines.length > 0 && lines[0].trim() === "") lines.shift();
              while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
              question = txt + "\n\n" + lines.join("\n");
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

    // Check if option elements indicate drag-and-drop / ordering
    if (optionElements.length > 0) {
      isDraggableOrder = optionElements.some((el) => {
        const isDrag = el.getAttribute("draggable") === "true" || el.draggable === true;
        const className = String(el.className || "").toLowerCase();
        const hasDragClass = className.includes("drag") || className.includes("sort") || className.includes("order");
        return isDrag || hasDragClass;
      });

      options = optionElements.map((el) => {
        const hasCode = !!(el.querySelector && el.querySelector("pre, code")) || (el.tagName && ["pre", "code"].includes(el.tagName.toLowerCase()));
        const raw = getCleanVisibleText(el, hasCode);
        const normalized = normalizeOptionWhitespace(raw, hasCode);
        return normalized || raw;
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
    normalizeTeX,
    stripDecorativePrefix,
    isVisible,
    isRadioOrOptionVisible,
    getCleanVisibleText,
    isHeaderOrNavText,
    isExplanationOrFeedback,
    findQuizCard,
    findClasslessOptionElements,
    extractQuizFromDom,
    applyDomHighlight
  };

  if (typeof window !== "undefined") {
    window.QuizZyExtractor = QuizZyExtractor;
    window.__QuizZyExtractor = QuizZyExtractor;
  }

  const __QUIZZY_EXTRACTION_RESULT__ = (typeof document !== "undefined")
    ? extractQuizFromDom()
    : { success: false, error: "No document object available for extraction." };

  if (typeof window !== "undefined") {
    window.__QUIZZY_LAST_EXTRACTION__ = __QUIZZY_EXTRACTION_RESULT__;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = QuizZyExtractor;
  }

  return (typeof module !== "undefined" && module.exports)
    ? QuizZyExtractor
    : __QUIZZY_EXTRACTION_RESULT__;
})();
