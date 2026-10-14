"""Answer normalization, synthetic indexing, canonicalization, and grading."""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field


SYNTHETIC_LABELS = ("A", "B", "C", "D", "E", "F")


class NormalizationError(ValueError):
    """Raised when an LLM answer cannot be normalized into a valid canonical form."""
    pass


class NormalizedAnswer(BaseModel):
    """Zero-DOM-Mutation ready canonical solver output."""
    canonical_key: str
    selected_index: Optional[int] = None
    selected_text: Optional[str] = None
    permutation_indices: Optional[List[int]] = None
    ordered_texts: Optional[List[str]] = None
    raw_answer: Any = None


def parse_options(options_raw: Union[str, List[str], Dict[str, str], None]) -> List[str]:
    """
    Parse options from a JSON string, list of strings, or legacy dict.
    Returns a list of raw option strings in their visual order.
    """
    if options_raw is None:
        return []
    if isinstance(options_raw, list):
        return [str(opt).strip() for opt in options_raw]
    if isinstance(options_raw, dict):
        # Legacy dict format {"A": "...", "B": "..."} -> sort by key
        return [str(options_raw[k]).strip() for k in sorted(options_raw.keys())]
    if isinstance(options_raw, str):
        trimmed = options_raw.strip()
        if not trimmed or trimmed in ("[]", "{}"):
            return []
        try:
            parsed = json.loads(trimmed)
            return parse_options(parsed)
        except Exception:
            return []
    return []


def normalize_text_answer(text: str) -> str:
    """
    Deterministic text normalization:
    - Unicode NFKC normalization
    - Lowercase
    - Strip whitespace and surrounding quotes
    - Strip leading English articles ('a ', 'an ', 'the ')
    - Strip trailing punctuation (., ;:!?)
    - Collapse multiple whitespace to single space
    - Normalize numeric strings ('1,000' -> '1000', '10.0' -> '10')
    - Canonicalize boolean shorthand ('t'/'true' -> 'true', 'f'/'false' -> 'false')
    """
    if not text:
        return ""

    # Unicode NFKC
    s = unicodedata.normalize("NFKC", str(text))
    s = s.lower().strip()

    # Strip surrounding quotes
    s = s.strip("\"'“”‘’`")

    # Strip leading English articles ONLY when followed by a multi-letter word (prose)
    # Never strip standalone letters ('A', 'a') or math expressions ('a - b', 'a : b', 'a = b', 'p(a)')
    s = re.sub(r"^(?:a|an)\s+(?=[a-z]{2,}\b)", "", s)
    s = re.sub(r"^the\s+(?=[a-z]{2,}\b)", "", s)

    # Strip trailing punctuation
    s = re.sub(r"[.,;:!?]+$", "", s).strip()

    # Collapse multiple internal whitespace
    s = re.sub(r"\s+", " ", s).strip()

    # Canonicalize booleans
    if s in ("t", "true"):
        return "true"
    if s in ("f", "false"):
        return "false"

    # Normalize numbers (e.g. '1,000' -> '1000', '10.0' -> '10')
    # Match numbers with commas like 1,000 or 1,234,567
    num_match = re.match(r"^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$", s)
    if num_match:
        s = s.replace(",", "")

    # Match float ending in .0, .00 etc. e.g. '1000.0' -> '1000'
    float_zero_match = re.match(r"^(-?\d+)\.0+$", s)
    if float_zero_match:
        s = float_zero_match.group(1)

    return s


def normalize_mcq_answer(raw_answer: Any, options: List[str]) -> NormalizedAnswer:
    """
    Normalize an MCQ answer against a list of 2-6 options.
    Accepts synthetic letter ('A', 'B', etc.) or option text.
    Returns NormalizedAnswer with canonical_key ('B'), selected_index (1), selected_text.
    """
    num_options = len(options)
    if num_options < 2 or num_options > 6:
        raise NormalizationError(f"MCQ requires between 2 and 6 options, got {num_options}")

    valid_letters = list(SYNTHETIC_LABELS[:num_options])

    # Convert raw_answer to string
    raw_str = str(raw_answer).strip()

    # Priority 1: Check if answer is explicitly a single letter e.g. 'B', 'B.', '(B)', '[B]', 'Option B'
    letter_match = re.match(r"^(?:option\s+)?(?:\(?\[?([A-Za-z])\)\]?[\.\:\)]?)$", raw_str, re.IGNORECASE)
    candidate_letter = None
    if letter_match:
        cand = letter_match.group(1).upper()
        if cand in valid_letters:
            candidate_letter = cand

    if candidate_letter is not None:
        idx = ord(candidate_letter) - 65
        return NormalizedAnswer(
            canonical_key=candidate_letter,
            selected_index=idx,
            selected_text=options[idx],
            raw_answer=raw_answer,
        )

    # Priority 2: Check if the raw string matches the text of an option
    normalized_raw = normalize_text_answer(raw_str)
    for i, opt in enumerate(options):
        if normalize_text_answer(opt) == normalized_raw:
            letter = chr(65 + i)
            return NormalizedAnswer(
                canonical_key=letter,
                selected_index=i,
                selected_text=options[i],
                raw_answer=raw_answer,
            )

    # Priority 3: Fallback loose letter match if no option text matched
    loose_match = re.search(r"\b([A-Za-z])\b", raw_str)
    if loose_match:
        cand = loose_match.group(1).upper()
        if cand in valid_letters:
            idx = ord(cand) - 65
            return NormalizedAnswer(
                canonical_key=cand,
                selected_index=idx,
                selected_text=options[idx],
                raw_answer=raw_answer,
            )

    # Substring match if unambiguous
    matches = [
        i for i, opt in enumerate(options)
        if normalized_raw and normalized_raw in normalize_text_answer(opt)
    ]
    if len(matches) == 1:
        idx = matches[0]
        letter = chr(65 + idx)
        return NormalizedAnswer(
            canonical_key=letter,
            selected_index=idx,
            selected_text=options[idx],
            raw_answer=raw_answer,
        )

    raise NormalizationError(
        f"Unable to normalize MCQ answer '{raw_answer}' with valid options {valid_letters}"
    )


def normalize_order_answer(raw_answer: Any, options: List[str]) -> NormalizedAnswer:
    """
    Normalize an ordering answer against unlabelled text blocks.
    Validates that the sequence is a complete, duplicate-free permutation of all available option letters.
    Produces canonical_key ('C,A,D,B'), permutation_indices ([2, 0, 3, 1]), and ordered_texts.
    """
    num_options = len(options)
    if num_options < 2 or num_options > 6:
        raise NormalizationError(f"Ordering requires between 2 and 6 options, got {num_options}")

    expected_letters = list(SYNTHETIC_LABELS[:num_options])
    expected_set = set(expected_letters)

    letters: List[str] = []

    # Case 1: raw_answer is a list/tuple
    if isinstance(raw_answer, (list, tuple)):
        # Check if list contains letters ['C', 'A', 'D', 'B']
        is_all_letters = all(
            isinstance(x, str) and x.strip().upper() in expected_set
            for x in raw_answer
        )
        if is_all_letters and len(raw_answer) == num_options:
            letters = [str(x).strip().upper() for x in raw_answer]
        else:
            # Check if list contains the full option strings in target order
            # Map each string back to its index
            mapped_indices: List[int] = []
            for item in raw_answer:
                item_norm = normalize_text_answer(str(item))
                found_idx = None
                for idx, opt in enumerate(options):
                    if normalize_text_answer(opt) == item_norm:
                        found_idx = idx
                        break
                if found_idx is None:
                    # Try substring
                    cand = [
                        idx for idx, opt in enumerate(options)
                        if item_norm and item_norm in normalize_text_answer(opt)
                    ]
                    if len(cand) == 1:
                        found_idx = cand[0]

                if found_idx is not None and found_idx not in mapped_indices:
                    mapped_indices.append(found_idx)
                else:
                    break

            if len(mapped_indices) == num_options:
                letters = [chr(65 + i) for i in mapped_indices]

    # Case 2: raw_answer is a string
    elif isinstance(raw_answer, str):
        trimmed = raw_answer.strip()
        # Check if JSON array string
        if trimmed.startswith("[") and trimmed.endswith("]"):
            try:
                parsed = json.loads(trimmed)
                return normalize_order_answer(parsed, options)
            except Exception:
                pass

        # Split by comma, hyphens, arrows, or whitespace
        # E.g. 'C,A,D,B', 'C, A, D, B', 'C-A-D-B', 'C -> A -> D -> B', 'CADB'
        extracted = re.findall(r"[A-Za-z]", trimmed)
        if len(extracted) == num_options:
            letters = [c.upper() for c in extracted]

    # Validate permutation
    if len(letters) != num_options:
        raise NormalizationError(
            f"Ordering answer must contain exactly {num_options} elements, got {len(letters)} from '{raw_answer}'"
        )

    if set(letters) != expected_set:
        raise NormalizationError(
            f"Ordering answer {letters} is not a valid permutation of {expected_letters}"
        )

    if len(letters) != len(set(letters)):
        raise NormalizationError(
            f"Ordering answer {letters} contains duplicates"
        )

    canonical_key = ",".join(letters)
    permutation_indices = [ord(c) - 65 for c in letters]
    ordered_texts = [options[i] for i in permutation_indices]

    return NormalizedAnswer(
        canonical_key=canonical_key,
        permutation_indices=permutation_indices,
        ordered_texts=ordered_texts,
        raw_answer=raw_answer,
    )


def normalize_answer(
    q_type: str,
    raw_answer: Any,
    options: List[str]
) -> NormalizedAnswer:
    """Route normalization by quiz question type (mcq, order, text)."""
    q_type_clean = q_type.strip().lower()

    if q_type_clean == "mcq":
        return normalize_mcq_answer(raw_answer, options)
    elif q_type_clean == "order":
        return normalize_order_answer(raw_answer, options)
    elif q_type_clean == "text":
        canon = normalize_text_answer(str(raw_answer) if raw_answer is not None else "")
        if not canon:
            raise NormalizationError("Free-text answer cannot be empty")
        return NormalizedAnswer(
            canonical_key=canon,
            selected_text=canon,
            raw_answer=raw_answer,
        )
    else:
        raise NormalizationError(f"Unsupported question type: '{q_type}'")


def grade_answer(
    predicted: NormalizedAnswer,
    expected_raw: str,
    q_type: str,
    options: List[str]
) -> bool:
    """
    Grade predicted answer against ground-truth expected_answer.
    Handles flexible expected formats:
    - mcq: synthetic letter ('B') or full option text ('Mitochondrion')
    - order: comma-separated synthetic letters ('C,A,D,B') or JSON array of target ordered texts
    - text: pipe-separated acceptable synonyms ('Au|gold')
    """
    q_type_clean = q_type.strip().lower()
    exp_str = str(expected_raw).strip()

    if q_type_clean == "mcq":
        # Check synthetic letter directly
        if len(exp_str) == 1 and exp_str.upper() == predicted.canonical_key.upper():
            return True
        # Check against full option text
        exp_norm = normalize_text_answer(exp_str)
        if predicted.selected_text and normalize_text_answer(predicted.selected_text) == exp_norm:
            return True
        # Check if exp_str is the text of the selected option index
        if predicted.selected_index is not None and 0 <= predicted.selected_index < len(options):
            if normalize_text_answer(options[predicted.selected_index]) == exp_norm:
                return True
        return False

    elif q_type_clean == "order":
        # exp_str could be 'C,A,D,B' or JSON array of target texts
        if exp_str.startswith("[") and exp_str.endswith("]"):
            try:
                norm_exp = normalize_order_answer(json.loads(exp_str), options)
                return predicted.canonical_key == norm_exp.canonical_key
            except Exception:
                pass

        # Normalize letters from expected string
        exp_letters = [c.upper() for c in re.findall(r"[A-Za-z]", exp_str)]
        exp_canonical = ",".join(exp_letters)
        return predicted.canonical_key == exp_canonical

    elif q_type_clean == "text":
        # Support pipe-separated synonyms e.g. 'Au|gold'
        synonyms = [normalize_text_answer(syn) for syn in exp_str.split("|")]
        pred_norm = predicted.canonical_key
        return pred_norm in synonyms

    return False
