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
   * Helper to identify QuizZy internal elements (such as the Floating HUD)
   * so they are 100% shielded from quiz detection and DOM traversal.
   */
  function isQuizZyInternalElement(el) {
    if (!el) return false;
    if (el.id === "__quizzy_hud_host__") return true;
    if (typeof el.getAttribute === "function" && el.getAttribute("data-quizzy-ignore") === "true") return true;
    if (typeof el.closest === "function") {
      try {
        if (el.closest("#__quizzy_hud_host__, [data-quizzy-ignore='true']")) return true;
      } catch (_) {}
    }
    return false;
  }

  /**
   * Checks if an element is visible in the layout.
   */
  function isVisible(el) {
    if (!el) return false;
    if (isQuizZyInternalElement(el)) return false;
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
      if (isQuizZyInternalElement(node)) {
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
  /**
   * Identifies non-question header, navigation, button, or explanation strings to prevent false positives.
   */
  function isHeaderOrNavText(text) {
    if (!text) return true;
    const t = text.trim();

    // Standalone action buttons
    if (/^(?:show\s*answer|hide\s*answer|submit|submit\s*answer|skip|next|next\s*question|previous|back|continue|report(?:\s*an)?\s*issue|check|finish|view\s*report)$/i.test(t)) {
      return true;
    }

    // Validation error messages (e.g. learning.ccbp.in red error banner)
    if (/^(?:please\s*select\s*(?:an?\s*)?(?:option|answer)|select\s*(?:an?\s*)?(?:option|answer))$/i.test(t)) {
      return true;
    }

    // Top-bar navigation, controls, scores, instructions, CCBP student ID & disclaimers
    if (/^(?:mcq\s*practice|practice\s*instructions|end\s*practice|end\s*test|submit\s*test|score\s*:\s*\d+|questions?\s*attempted\s*:\s*\d+|time\s*left|timer\s*:|id\s*:\s*[A-Za-z0-9]+)/i.test(t)) {
      return true;
    }

    if (/^if\s+you\s+skip,\s+you\s+can\s+attempt\s+this\s+question\s+again/i.test(t)) {
      return true;
    }

    // Post-submit explanation or feedback title headers
    if (t.length <= 40 && /^(?:explanation|solution|correct\s*answer|your\s*answer|detailed\s*solution|answer\s*key|hint|review(?:\s*questions)?)$/i.test(t)) {
      return true;
    }

    // Numbering artifacts like "Question 1 of 15" or "Q1."
    if (/^(?:question\s*\d+\s*(?:of|\/)\s*\d+|q\s*\d+[\.\:\s]*)$/i.test(t)) {
      return true;
    }

    return false;
  }

  /**
   * Helper that checks if an element or any of its descendants is or contains an action button
   * (e.g. SUBMIT, SHOW ANSWER, SKIP) or a quiz footer/disclaimer (e.g. "If you skip...")
   * or a validation error message (e.g. "Please select an option").
   */
  function containsActionButtonOrFooter(el) {
    if (!el || el.nodeType !== 1) return false;
    const actionPattern = /^(?:SHOW ANSWER|HIDE ANSWER|SUBMIT|SUBMIT ANSWER|SKIP|NEXT|NEXT QUESTION|PREVIOUS|END PRACTICE|PRACTICE INSTRUCTIONS|HINT|REPORT|CHECK|FINISH|VIEW REPORT|PLEASE SELECT AN OPTION|PLEASE SELECT AN ANSWER|SELECT AN OPTION|SELECT AN ANSWER)$/;
    const footerKeywords = /(?:IF YOU SKIP, YOU CAN ATTEMPT|QUESTIONS ATTEMPTED|END PRACTICE|PRACTICE INSTRUCTIONS|PLEASE SELECT AN OPTION|PLEASE SELECT AN ANSWER|SELECT AN OPTION)/;

    const elText = cleanText(el.textContent || el.innerText || "").toUpperCase();
    if (actionPattern.test(elText) || footerKeywords.test(elText)) {
      return true;
    }

    const descendants = el.querySelectorAll ? Array.from(el.querySelectorAll("button, [role='button'], a, div, span, p")) : [];
    for (const d of descendants) {
      const dText = cleanText(d.textContent || d.innerText || "").toUpperCase();
      if (actionPattern.test(dText) || footerKeywords.test(dText)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Checks if an element is part of a post-submit explanation or feedback container.
   * Walks up the ancestor chain and inspects container classes, IDs, headings, and sibling headings.
   */
  function isExplanationOrFeedback(el) {
    if (!el || el.nodeType !== 1) return false;
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
        if (fcTag !== "button" && /^h[1-6]$|strong|b/.test(fcTag)) {
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
   * Walks up from action button all the way until just BEFORE the top page navbar or document body,
   * verifying it contains substantial content above the buttons.
   */
  function findQuizCard(doc) {
    if (!doc) return null;
    if (isQuizZyInternalElement(doc)) return null;

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
        if (isQuizZyInternalElement(el)) continue;
        if (!isExplanationOrFeedback(el)) return el;
      }
    }

    // 2. Button-anchored discovery (for styled-components / sc-...)
    const buttons = Array.from(doc.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")).filter(isVisible);
    let actionBtn = null;
    for (const btn of buttons) {
      if (isQuizZyInternalElement(btn)) continue;
      const txt = cleanText(btn.textContent || btn.value || "");
      if (/^(?:submit|show\s*answer|next\s*question|next|check|skip)$/i.test(txt)) {
        actionBtn = btn;
        if (/^(?:submit|show\s*answer)$/i.test(txt)) break;
      }
    }

    if (actionBtn) {
      let curr = actionBtn.parentElement;
      let bestCard = null;

      while (curr && curr !== doc.body && curr !== doc.documentElement) {
        if (isQuizZyInternalElement(curr)) break;
        const currText = curr.textContent || "";
        const hasTopNavMarkers = /mcq\s*practice|end\s*practice|questions?\s*attempted|practice\s*instructions/i.test(currText);
        if (hasTopNavMarkers) {
          // Reached or surpassed page wrapper enclosing the navbar; stop here!
          break;
        }

        // Check if curr has substantial content above/outside the action buttons & skip footer
        const nonActionText = currText
          .replace(/show\s*answer|hide\s*answer|submit(?:\s*answer)?|skip|next(?:\s*question)?|previous|end\s*practice|practice\s*instructions|if\s*you\s*skip[^\n]*/gi, "")
          .trim();

        if (nonActionText.length >= 15) {
          bestCard = curr;
        }

        curr = curr.parentElement;
      }

      if (bestCard) {
        return bestCard;
      }
    }

    // 3. Fallbacks
    const generic = Array.from(doc.querySelectorAll("main, [role='main'], form, .card")).filter(isVisible);
    for (const el of generic) {
      if (isQuizZyInternalElement(el)) continue;
      if (!isExplanationOrFeedback(el)) return el;
    }

    return null;
  }

  /**
   * Classless Option Group Discovery (for styled-components / sc-... without radio inputs or semantic classes).
   * Disqualifies layout section wrappers and ensures options container is preceded by question stem text.
   */
  function findClasslessOptionElements(scopeRoot, docRef) {
    const scope = scopeRoot || docRef || (typeof document !== "undefined" ? document : null);
    if (!scope) return [];
    if (isQuizZyInternalElement(scope)) return [];

    const candidateContainers = Array.from(scope.querySelectorAll("div, ul, ol")).filter(isVisible);
    const allDescendants = Array.from(scope.querySelectorAll("*"));

    for (let i = candidateContainers.length - 1; i >= 0; i--) {
      const container = candidateContainers[i];
      if (container === scope) continue;
      if (isQuizZyInternalElement(container)) continue;

      const rawChildren = Array.from(container.children || []).filter(c => isVisible(c) && !isQuizZyInternalElement(c));
      const validChildren = rawChildren.filter(c => {
        const tag = (c.tagName || "").toLowerCase();
        return ["div", "li", "button", "label", "a", "span"].includes(tag);
      });

      if (validChildren.length < 2 || validChildren.length > 6) continue;

      // Disqualify immediately if ANY candidate child is or contains an action button or footer
      const hasActionChild = validChildren.some(c => containsActionButtonOrFooter(c));
      if (hasActionChild) continue;

      // All children should share the same tag name
      const firstTag = (validChildren[0].tagName || "").toLowerCase();
      const allSameTag = validChildren.every(c => (c.tagName || "").toLowerCase() === firstTag);
      if (!allSameTag) continue;

      // Check each child has clean visible text between 1 and 300 characters
      const texts = validChildren.map(c => getCleanVisibleText(c));
      const validTexts = texts.every(t => t.length >= 1 && t.length <= 300 && !isHeaderOrNavText(t));
      if (!validTexts) continue;

      const uniqueTexts = new Set(texts);
      if (uniqueTexts.size < 2) continue;

      // Disqualify immediately if there is NO question text inside scope preceding this container
      const containerIdx = allDescendants.indexOf(container);
      if (containerIdx > 0) {
        let hasPrecedingText = false;
        for (let j = 0; j < containerIdx; j++) {
          const prev = allDescendants[j];
          if (container.contains && container.contains(prev)) continue;
          if (containsActionButtonOrFooter(prev)) continue;
          const prevTxt = getCleanVisibleText(prev);
          if (prevTxt.length >= 8 && !isHeaderOrNavText(prevTxt)) {
            hasPrecedingText = true;
            break;
          }
        }
        if (!hasPrecedingText) continue;
      } else {
        continue;
      }

      return validChildren;
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
      if (found.length >= 2) {
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
      if (el && isVisible(el) && !isExplanationOrFeedback(el)) {
        const txt = getCleanVisibleText(el);
        if (txt.length >= 8 && !isHeaderOrNavText(txt)) {
          question = txt;
          matchedSelectors.question = custom.questionSelector;
        }
      }
    }

    // Outermost content blocks discovery inside quiz card strictly preceding optionElements[0]
    // Fixes multi-block Assertion (A) & Reason (R) and multi-statement questions on learning.ccbp.in
    if (!question) {
      let cardContainers = (quizCard ? [quizCard] : Array.from(doc.querySelectorAll(
        "[class*='question-card'], [class*='questionCard'], [class*='questionContainer'], [class*='question-container'], [class*='quiz-card'], [class*='quizCard'], [class*='quiz-container'], [class*='quizContainer'], [class*='practice-card'], [class*='problem-card'], [class*='mcq-card'], [class*='card'], .card, main, [role='main'], form"
      ))).filter(isVisible);

      // If no card container found yet but options exist, walk up from first option to find common card
      const firstOpt = (optionElements && optionElements.length > 0) ? optionElements[0] : null;
      if (cardContainers.length === 0 && firstOpt) {
        let curr = firstOpt.parentElement;
        while (curr && curr !== doc.body && curr !== doc.documentElement) {
          if (isQuizZyInternalElement(curr)) break;
          const allDesc = Array.from(curr.querySelectorAll("*"));
          if (allDesc.indexOf(firstOpt) > 0) {
            cardContainers = [curr];
            break;
          }
          curr = curr.parentElement;
        }
      }

      for (const card of cardContainers) {
        if (isExplanationOrFeedback(card)) continue;

        const allDescendants = Array.from(card.querySelectorAll("*"));
        const firstOptIndex = firstOpt ? allDescendants.indexOf(firstOpt) : -1;

        // Visual position boundary if getBoundingClientRect is available
        let firstOptTop = Infinity;
        if (firstOpt && typeof firstOpt.getBoundingClientRect === "function") {
          const r = firstOpt.getBoundingClientRect();
          if (r && (r.top !== 0 || r.bottom !== 0)) {
            firstOptTop = r.top;
          }
        }

        // Elements inside card strictly preceding firstOpt in pre-order traversal
        const precedingElements = (firstOptIndex !== -1)
          ? allDescendants.slice(0, firstOptIndex).filter(el => !el.contains(firstOpt))
          : allDescendants;

        // Filter to all visible content blocks (p, div, span, pre, code, table, li, h1-h4)
        const selectedBlocks = [];
        for (const el of precedingElements) {
          if (!isVisible(el)) continue;
          if (containsActionButtonOrFooter(el)) continue;
          if (isExplanationOrFeedback(el)) continue;

          // Check visual layout position: must appear above the first option element
          if (firstOptTop !== Infinity && typeof el.getBoundingClientRect === "function") {
            const elRect = el.getBoundingClientRect();
            if (elRect && (elRect.top !== 0 || elRect.bottom !== 0) && elRect.bottom > firstOptTop + 8) {
              continue;
            }
          }

          // If an ancestor is already selected in selectedBlocks, skip descendant to avoid duplicate text
          const hasSelectedAncestor = selectedBlocks.some(parent => parent.contains(el));
          if (hasSelectedAncestor) continue;

          const tag = (el.tagName || "").toLowerCase();
          if (tag === "button" || tag === "input" || tag === "hr" || tag === "br" || tag === "style" || tag === "script") continue;
          if (el.querySelector && el.querySelector("input[type='radio'], [role='radio'], [class*='option'], button")) continue;

          // If this element contains child blocks (p, div, span, etc.) that themselves have text,
          // prefer selecting the more granular child blocks rather than the whole container
          if (tag !== "pre" && tag !== "code" && el.querySelector && el.querySelector("p, h1, h2, h3, h4, pre, code, table, li")) {
            continue;
          }

          const isCode = tag === "pre" || tag === "code";
          const txt = getCleanVisibleText(el, isCode);
          if (txt.length >= 3 && !isHeaderOrNavText(txt)) {
            // Exclude header boilerplate
            if (!/^(?:mcq\s*practice|practice\s*instructions|end\s*practice|score\s*:|questions?\s*attempted)/i.test(txt)) {
              selectedBlocks.push(el);
            }
          }
        }

        const stemParts = [];
        for (const block of selectedBlocks) {
          const tag = (block.tagName || "").toLowerCase();
          const isCode = tag === "pre" || tag === "code";
          if (isCode) {
            const rawCode = (block.textContent || block.innerText || "");
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
            const txt = getCleanVisibleText(block, false);
            if (txt.length >= 3 && !isHeaderOrNavText(txt)) {
              if (!stemParts.includes(txt) && !stemParts.some(p => p.includes(txt))) {
                stemParts.push(txt);
              }
            }
          }
        }

        if (stemParts.length > 0) {
          question = stemParts.join("\n").trim();
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
    containsActionButtonOrFooter,
    isExplanationOrFeedback,
    findQuizCard,
    findClasslessOptionElements,
    extractQuizFromDom,
    applyDomHighlight,
    isQuizZyInternalElement
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
