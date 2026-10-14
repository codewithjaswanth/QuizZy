"""Shared core package for QuizZy solver engines and evaluation harnesses."""

from backend.core.llm_client import (
    SolverResponse,
    check_models,
    load_api_keys,
    load_models_config,
    solve_question,
)
from backend.core.normalizer import (
    NormalizationError,
    NormalizedAnswer,
    grade_answer,
    normalize_answer,
    normalize_mcq_answer,
    normalize_order_answer,
    normalize_text_answer,
    parse_options,
)
from backend.core.parser import (
    ParseError,
    ParsedLLMResponse,
    parse_llm_response,
)
from backend.core.prompts import (
    SYSTEM_PROMPT,
    build_prompt_messages,
    build_user_prompt,
)

__all__ = [
    "NormalizedAnswer",
    "NormalizationError",
    "parse_options",
    "normalize_answer",
    "normalize_mcq_answer",
    "normalize_order_answer",
    "normalize_text_answer",
    "grade_answer",
    "SYSTEM_PROMPT",
    "build_user_prompt",
    "build_prompt_messages",
    "ParsedLLMResponse",
    "ParseError",
    "parse_llm_response",
    "SolverResponse",
    "solve_question",
    "check_models",
    "load_models_config",
    "load_api_keys",
]
