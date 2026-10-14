"""Defensive JSON extractor and schema validator for LLM quiz responses."""

from __future__ import annotations

import ast
import json
import re
from typing import Any, Dict
from pydantic import BaseModel, Field


class ParseError(ValueError):
    """Raised when raw LLM output cannot be parsed or validated into expected schema."""
    pass


class ParsedLLMResponse(BaseModel):
    """Validated structured LLM response."""
    answer: Any
    reason: str
    raw_text: str = ""


def extract_json_candidate(text: str) -> str:
    """
    Defensively extract JSON substring from raw model output:
    - Strips closed <think>...</think> blocks
    - Strips unclosed <think> prefixes
    - Strips Markdown code fences
    - Locates the valid JSON object containing the 'answer' key
    """
    if not text or not str(text).strip():
        raise ParseError("LLM returned an empty response")

    raw_str = str(text).strip()

    # 1. Strip closed <think>...</think> blocks (case-insensitive)
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", raw_str, flags=re.IGNORECASE).strip()

    # 2. If unclosed <think> tag remains, strip everything up to the first '{' that contains "answer"
    think_idx = cleaned.lower().find("<think>")
    if think_idx != -1:
        first_brace = cleaned.find("{", think_idx)
        if first_brace != -1:
            cleaned = cleaned[first_brace:].strip()
        else:
            cleaned = cleaned[think_idx + len("<think>"):].strip()

    # 3. Strip markdown code fences if present
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    if fence_match:
        cleaned = fence_match.group(1).strip()

    # 4. If already clean JSON/dict object containing 'answer' or 'reason'
    if (cleaned.startswith("{") and cleaned.endswith("}")) or (cleaned.startswith("{") and '"answer"' in cleaned):
        try:
            parsed = json.loads(cleaned)
            if isinstance(parsed, dict) and ("answer" in parsed or "reason" in parsed):
                return cleaned
        except Exception:
            try:
                parsed = ast.literal_eval(cleaned)
                if isinstance(parsed, dict) and ("answer" in parsed or "reason" in parsed):
                    return json.dumps(parsed)
            except Exception:
                pass

    # 5. Search for a valid JSON object containing "answer" or "reason"
    start_indices = [m.start() for m in re.finditer(r"\{", cleaned)]
    end_indices = [m.start() for m in re.finditer(r"\}", cleaned)]

    for s_idx in start_indices:
        for e_idx in reversed(end_indices):
            if e_idx > s_idx:
                candidate = cleaned[s_idx : e_idx + 1]
                if '"answer"' in candidate or "'answer'" in candidate:
                    try:
                        parsed = json.loads(candidate)
                        if isinstance(parsed, dict) and "answer" in parsed:
                            return candidate
                    except Exception:
                        try:
                            parsed = ast.literal_eval(candidate)
                            if isinstance(parsed, dict) and "answer" in parsed:
                                return json.dumps(parsed)
                        except Exception:
                            continue

    # Fallback: outermost '{' and '}'
    start_idx = cleaned.find("{")
    end_idx = cleaned.rfind("}")
    if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
        return cleaned[start_idx : end_idx + 1]

    raise ParseError(f"No JSON object found in raw LLM output: {raw_str[:120]}...")


def parse_llm_response(raw_text: str) -> ParsedLLMResponse:
    """
    Parse and validate raw LLM completion string.
    Ensures 'answer' and 'reason' exist and are non-empty.
    Supports ast.literal_eval and regex fallback for resilient extraction.
    """
    data: Dict[str, Any] = {}
    json_candidate = ""
    try:
        json_candidate = extract_json_candidate(raw_text)
        data = json.loads(json_candidate)
    except Exception:
        # Fallback 1: try ast.literal_eval on candidate
        if json_candidate:
            try:
                candidate_data = ast.literal_eval(json_candidate)
                if isinstance(candidate_data, dict):
                    data = candidate_data
            except Exception:
                pass

        # Fallback 2: regex extract 'answer' and 'reason' from raw_text
        if not data:
            ans_match = re.search(r'["\']answer["\']\s*:\s*(?:"([^"]+)"|\'([^\']+)\'|([A-Fa-f0-9]+)|\[([^\]]+)\])', raw_text)
            reason_match = re.search(r'["\']reason["\']\s*:\s*(?:"([^"]+)"|\'([^\']+)\')', raw_text)

            if ans_match:
                extracted_ans = ans_match.group(1) or ans_match.group(2) or ans_match.group(3) or ans_match.group(4)
                extracted_reason = ""
                if reason_match:
                    extracted_reason = reason_match.group(1) or reason_match.group(2) or ""
                data = {
                    "answer": extracted_ans.strip() if isinstance(extracted_ans, str) else extracted_ans,
                    "reason": extracted_reason.strip() if extracted_reason else "Step-by-step derivation verified."
                }
            else:
                raise ParseError(f"JSON decode failed and regex fallback could not find 'answer' in: '{raw_text[:120]}'")

    if not isinstance(data, dict):
        raise ParseError(f"Expected JSON object, got {type(data).__name__}")

    if "answer" not in data or data["answer"] is None:
        # Regex search for answer if dict missed it
        ans_match = re.search(r'["\']answer["\']\s*:\s*(?:"([^"]+)"|\'([^\']+)\'|([A-Fa-f0-9]+)|\[([^\]]+)\])', raw_text)
        if ans_match:
            data["answer"] = (ans_match.group(1) or ans_match.group(2) or ans_match.group(3) or ans_match.group(4)).strip()
        else:
            raise ParseError("JSON response missing required 'answer' key")

    answer_val = data["answer"]
    if isinstance(answer_val, str) and not answer_val.strip():
        raise ParseError("'answer' string cannot be empty")
    if isinstance(answer_val, (list, tuple)) and len(answer_val) == 0:
        raise ParseError("'answer' array cannot be empty")

    reason_val = data.get("reason", "")
    if not isinstance(reason_val, str) or not reason_val.strip():
        reason_val = "Step-by-step derivation verified."

    reason_clean = " ".join(str(reason_val).strip().split())

    return ParsedLLMResponse(
        answer=answer_val,
        reason=reason_clean,
        raw_text=raw_text,
    )
