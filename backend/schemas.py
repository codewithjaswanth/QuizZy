"""Pydantic v2 schemas for QuizZy FastAPI backend."""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field, field_validator, model_validator


class SolveRequest(BaseModel):
    """Request schema for POST /solve."""
    subject: str = Field(default="General", max_length=100)
    q_type: Literal["mcq", "order", "text"]
    question: str = Field(min_length=1, max_length=4000)
    options: List[str] = Field(default_factory=list)
    bypass_cache: bool = Field(default=False)

    @field_validator("subject", mode="before")
    @classmethod
    def clean_subject(cls, v: Any) -> str:
        s = str(v).strip() if v else "General"
        return s[:100] if s else "General"

    @field_validator("question", mode="before")
    @classmethod
    def clean_question(cls, v: Any) -> str:
        s = str(v).strip() if v else ""
        if not s:
            raise ValueError("question field cannot be blank or empty")
        return s

    @model_validator(mode="after")
    def validate_options_for_type(self) -> SolveRequest:
        if self.q_type in ("mcq", "order"):
            if len(self.options) < 2 or len(self.options) > 6:
                raise ValueError(
                    f"Question type '{self.q_type}' requires between 2 and 6 options, got {len(self.options)}"
                )
        return self


class SolveResponse(BaseModel):
    """Response schema for POST /solve."""
    status: Literal["ok", "uncertain"]
    q_type: Literal["mcq", "order", "text"]
    answer: str = ""
    selected_index: Optional[int] = None
    selected_text: Optional[str] = None
    permutation_indices: Optional[List[int]] = None
    ordered_texts: Optional[List[str]] = None
    reason: str = ""
    confidence_tier: str
    confidence_label: Literal["high", "medium", "low", "uncertain"]
    confidence_score: float
    auto_eligible: bool
    cache_hit: bool
    latency_ms: float
    searxng_used: bool = False
    search_sources: List[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    """Response schema for GET /health."""
    status: str = "ok"
    models: Dict[str, Any]
    cache_entries: int
    searxng_enabled: bool = True
    searxng_circuit_open: bool = False
    openrouter_keys_loaded: int = 1
    active_fallback_pool: List[str] = Field(default_factory=list)


class StatsResponse(BaseModel):
    """Response schema for GET /stats."""
    status: str = "ok"
    cache_entries: int
    total_hits: int
    total_misses: int
    total_requests: int
    hit_rate_pct: float
    wrong_answers_count: int = 0
    user_overrides_count: int = 0


class FeedbackRequest(BaseModel):
    """Request schema for POST /feedback."""
    subject: str = Field(default="General", max_length=100)
    q_type: Literal["mcq", "order", "text"]
    question: str = Field(min_length=1, max_length=4000)
    options: List[str] = Field(default_factory=list)
    wrong_model_answer: str = ""
    correct_answer: Optional[Any] = None
    confidence_tier_at_failure: str = ""
    notes: str = ""
    export_to_csv: bool = True

    @field_validator("subject", mode="before")
    @classmethod
    def clean_subject(cls, v: Any) -> str:
        s = str(v).strip() if v else "General"
        return s[:100] if s else "General"

    @field_validator("question", mode="before")
    @classmethod
    def clean_question(cls, v: Any) -> str:
        s = str(v).strip() if v else ""
        if not s:
            raise ValueError("question field cannot be blank or empty")
        return s


class FeedbackResponse(BaseModel):
    """Response schema for POST /feedback."""
    status: Literal["ok"] = "ok"
    action: Literal["evicted_and_logged", "overridden_and_logged", "exported_to_csv"]
    cache_key: str
    csv_exported: bool = False
    csv_row_id: Optional[str] = None
