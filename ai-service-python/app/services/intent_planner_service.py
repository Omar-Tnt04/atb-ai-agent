from typing import Any

from app.config import settings
from app.prompts.intent_planner_prompt import ALLOWED_PLANNER_INTENT_TYPES
from app.schemas.agent import AgentAnalyzeRequest
from app.services.architecture_logger import logArchitecture
from app.services.ollama_service import (
    OllamaJsonParseError,
    OllamaServiceError,
    plan_intent_with_ollama,
)


class IntentPlannerError(Exception):
    """Raised when the planner cannot produce valid planner JSON."""


INTENT_DEFAULTS = {
    "resource_qa": {
        "resourceNeed": True,
        "needsDownload": False,
        "actionType": "none",
    },
    "document_show": {
        "resourceNeed": True,
        "needsDownload": True,
        "actionType": "none",
    },
    "action_prepare": {
        "resourceNeed": True,
        "needsDownload": False,
        "actionType": "none",
    },
    "multi_resource_search": {
        "resourceNeed": True,
        "needsDownload": False,
        "actionType": "none",
    },
    "account_balance": {
        "resourceNeed": False,
        "needsDownload": False,
        "actionType": "none",
    },
    "clarification": {
        "resourceNeed": False,
        "needsDownload": False,
        "actionType": "none",
    },
    "no_match": {
        "resourceNeed": False,
        "needsDownload": False,
        "actionType": "none",
    },
}

OLD_MODE_TO_INTENT = {
    "resource_qa": "resource_qa",
    "resource_document": "document_show",
    "banking_action": "action_prepare",
    "resource_search": "multi_resource_search",
    "natural_chat": "no_match",
    "clarification": "clarification",
}


def _clean_optional_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def _clamp_confidence(value: Any) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.5
    return max(0.0, min(1.0, numeric))


def _is_card_resource_question(message: str) -> bool:
    import re

    text = " ".join(str(message or "").lower().replace("_", " ").replace("-", " ").split())
    return bool(
        re.search(r"\b(?:credit\s+card|card)\b.{0,50}\b(?:current\s+)?limit\b", text)
        or re.search(r"\b(?:current\s+|available\s+)?limit\b.{0,50}\b(?:credit\s+card|card)\b", text)
        or re.search(r"\bavailable\s+(?:card\s+)?limit\b", text)
        or re.search(r"\b(?:credit\s+card|card)\b.{0,50}\bpayment\s+due(?:\s+date)?\b", text)
        or re.search(r"\bpayment\s+due(?:\s+date)?\b.{0,50}\b(?:credit\s+card|card)\b", text)
        or re.search(r"\b(?:credit\s+card|card)\b.{0,50}\bminimum\s+payment\b", text)
        or re.search(r"\bminimum\s+payment\b.{0,50}\b(?:credit\s+card|card)\b", text)
        or re.search(r"\bcard\s+notice\b", text)
    )


def build_safe_planner_fallback(
    request: AgentAnalyzeRequest,
    reason: str = "Planner output could not be parsed, so the backend should attempt a safe resource search.",
) -> dict[str, Any]:
    return {
        "intentType": "multi_resource_search",
        "needsDownload": False,
        "needsVision": False,
        "resourceNeed": True,
        "resourceQuery": request.message,
        "resourceCategoryHint": None,
        "actionType": "none",
        "missingFields": [],
        "userGoal": _clean_optional_string(request.message),
        "confidence": 0.4,
    }


def _validate_planner_result(raw_result: dict[str, Any], request: AgentAnalyzeRequest) -> dict[str, Any]:
    if not isinstance(raw_result, dict):
        return build_safe_planner_fallback(request)

    intent_type = _clean_optional_string(raw_result.get("intentType"))
    if intent_type not in ALLOWED_PLANNER_INTENT_TYPES:
        intent_type = OLD_MODE_TO_INTENT.get(_clean_optional_string(raw_result.get("mode")) or "", "no_match")
    if _is_card_resource_question(request.message):
        intent_type = "resource_qa"

    defaults = INTENT_DEFAULTS[intent_type]
    resource_query = (
        _clean_optional_string(raw_result.get("resourceQuery")) or
        _clean_optional_string(raw_result.get("resourceSearchQuery"))
    )
    resource_need = bool(raw_result.get(
        "resourceNeed",
        raw_result.get("needsResourceSearch", defaults["resourceNeed"]),
    ))
    if resource_need and not resource_query:
        resource_query = request.message
    if intent_type == "resource_qa" and _is_card_resource_question(request.message):
        resource_need = True
        resource_query = "credit card limit"

    action_type = _clean_optional_string(raw_result.get("actionType")) or defaults["actionType"]
    if intent_type not in {"action_prepare", "account_balance"}:
        action_type = "none"
    if action_type not in {"pay_bill", "transfer", "complaint", "appointment", "cancel", "reset", "none"}:
        action_type = "none"

    missing_fields = raw_result.get("missingFields")
    if not isinstance(missing_fields, list):
        missing_fields = []

    return {
        "intentType": intent_type,
        "userGoal": _clean_optional_string(raw_result.get("userGoal")) or request.message,
        "resourceNeed": resource_need,
        "resourceQuery": resource_query,
        "resourceCategoryHint": _clean_optional_string(raw_result.get("resourceCategoryHint")),
        "actionType": action_type,
        "needsVision": bool(raw_result.get("needsVision", False)),
        "needsDownload": bool(raw_result.get("needsDownload", defaults["needsDownload"])),
        "missingFields": [
            item.strip() for item in missing_fields
            if isinstance(item, str) and item.strip()
        ],
        "confidence": _clamp_confidence(raw_result.get("confidence")),
    }


def _summarize_attached_context(request: AgentAnalyzeRequest) -> str:
    """Returns a compact one-line summary of which hint sources are present."""
    parts: list[str] = []

    if request.threadContext:
        tc = request.threadContext
        turns = len(tc.priorTurns or [])
        last = tc.lastIntent or "none"
        parts.append(f"thread(turns={turns} lastIntent={last})")

    if request.requestContext:
        rc = request.requestContext
        intent_type = (rc.intentClass or {}).get("type", "none")
        conf = (rc.intentClass or {}).get("confidence", 0.0)
        has_page = bool((rc.currentPage or {}).get("url"))
        parts.append(f"reqCtx(intent={intent_type} conf={conf:.2f} hasPage={has_page})")

    if request.agentPlan:
        plan = request.agentPlan
        parts.append(
            f"plan(executor={plan.executorType} route={plan.selectedRoute}"
            f" conf={plan.confidence:.2f} allowed={plan.allowed})"
        )

    return " ".join(parts) if parts else "none"


def plan_intent(request: AgentAnalyzeRequest) -> dict[str, Any]:
    if not settings.USE_OLLAMA:
        raise IntentPlannerError("Ollama planner is disabled")

    ctx_summary = _summarize_attached_context(request)
    logArchitecture("planner_context_attached", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "contextSources": ctx_summary,
        "messageLength": len(request.message or ""),
    })

    try:
        raw_result = plan_intent_with_ollama(request)
    except OllamaJsonParseError as exc:
        logArchitecture("planner_safe_fallback_used", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "messageLength": len(request.message or ""),
            "reason": str(exc),
        }, level="warning")
        return build_safe_planner_fallback(request)
    except OllamaServiceError as exc:
        raise IntentPlannerError(str(exc)) from exc

    return _validate_planner_result(raw_result, request)
