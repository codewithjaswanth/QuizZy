"""Defensive JSON extractor and schema validator for LLM quiz responses."""

from __future__ import annotations

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
        cleaned = cleaned[think_idx + len("<think>"):].strip()

    # 3. Strip markdown code fences if present
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
    if fence_match:
        cleaned = fence_match.group(1).strip()

    # 4. If already clean JSON object containing 'answer'
    if cleaned.startswith("{") and cleaned.endswith("}"):
        try:
            parsed = json.loads(cleaned)
            if isinstance(parsed, dict) and "answer" in parsed:
                return cleaned
        except Exception:
            pass

    # 5. Search for a valid JSON object containing "answer"
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
    """
    json_str = extract_json_candidate(raw_text)

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as exc:
        raise ParseError(f"JSON decode failed: {exc} on candidate: '{json_str[:100]}'") from exc

    if not isinstance(data, dict):
        raise ParseError(f"Expected JSON object, got {type(data).__name__}")

    if "answer" not in data:
        raise ParseError("JSON response missing required 'answer' key")

    answer_val = data["answer"]
    if answer_val is None:
        raise ParseError("'answer' key cannot be null")
    if isinstance(answer_val, str) and not answer_val.strip():
        raise ParseError("'answer' string cannot be empty")
    if isinstance(answer_val, (list, tuple)) and len(answer_val) == 0:
        raise ParseError("'answer' array cannot be empty")

    reason_val = data.get("reason", "")
    if not isinstance(reason_val, str) or not reason_val.strip():
        raise ParseError("Missing or empty 'reason' string in response")

    reason_clean = " ".join(reason_val.strip().split())

    return ParsedLLMResponse(
        answer=answer_val,
        reason=reason_clean,
        raw_text=raw_text,
    )
