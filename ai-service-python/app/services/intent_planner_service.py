from typing import Any

from app.config import settings
from app.prompts.intent_planner_prompt import ALLOWED_PLANNER_MODES
from app.schemas.agent import AgentAnalyzeRequest
from app.services.architecture_logger import logArchitecture, message_preview
from app.services.ollama_service import (
    OllamaJsonParseError,
    OllamaServiceError,
    plan_intent_with_ollama,
)


class IntentPlannerError(Exception):
    """Raised when the planner cannot produce valid planner JSON."""


MODE_DEFAULTS = {
    "resource_qa": {
        "needsResourceSearch": True,
        "needsActionFlow": False,
        "needsDownload": False,
    },
    "resource_document": {
        "needsResourceSearch": True,
        "needsActionFlow": False,
        "needsDownload": False,
    },
    "banking_action": {
        "needsResourceSearch": True,
        "needsActionFlow": True,
        "needsDownload": False,
    },
    "resource_search": {
        "needsResourceSearch": True,
        "needsActionFlow": False,
        "needsDownload": False,
    },
    "natural_chat": {
        "needsResourceSearch": False,
        "needsActionFlow": False,
        "needsDownload": False,
    },
    "clarification": {
        "needsResourceSearch": False,
        "needsActionFlow": False,
        "needsDownload": False,
    },
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


def build_safe_planner_fallback(
    request: AgentAnalyzeRequest,
    reason: str = "Planner output could not be parsed, so the backend should attempt a safe resource search.",
) -> dict[str, Any]:
    return {
        "mode": "resource_search",
        "needsResourceSearch": True,
        "resourceSearchQuery": request.message,
        "needsActionFlow": False,
        "needsDownload": False,
        "actionType": None,
        "userGoal": _clean_optional_string(request.message),
        "confidence": 0.4,
        "reason": reason,
    }


def _validate_planner_result(raw_result: dict[str, Any], request: AgentAnalyzeRequest) -> dict[str, Any]:
    if not isinstance(raw_result, dict):
        return build_safe_planner_fallback(request)

    mode = _clean_optional_string(raw_result.get("mode"))
    if mode not in ALLOWED_PLANNER_MODES:
        mode = "natural_chat"

    defaults = MODE_DEFAULTS[mode]
    resource_query = _clean_optional_string(raw_result.get("resourceSearchQuery"))
    needs_resource_search = bool(
        raw_result.get("needsResourceSearch", defaults["needsResourceSearch"])
    )
    if needs_resource_search and not resource_query:
        resource_query = request.message

    needs_action_flow = mode == "banking_action"
    action_type = _clean_optional_string(raw_result.get("actionType"))
    if mode != "banking_action":
        action_type = None

    return {
        "mode": mode,
        "needsResourceSearch": needs_resource_search,
        "resourceSearchQuery": resource_query,
        "needsActionFlow": needs_action_flow,
        "needsDownload": mode == "resource_document",
        "actionType": action_type,
        "userGoal": _clean_optional_string(raw_result.get("userGoal")) or request.message,
        "confidence": _clamp_confidence(raw_result.get("confidence")),
        "reason": _clean_optional_string(raw_result.get("reason")) or f"Planner selected {mode}.",
    }


def plan_intent(request: AgentAnalyzeRequest) -> dict[str, Any]:
    if not settings.USE_OLLAMA:
        raise IntentPlannerError("Ollama planner is disabled")

    try:
        raw_result = plan_intent_with_ollama(request)
    except OllamaJsonParseError as exc:
        logArchitecture("planner_safe_fallback_used", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "messagePreview": message_preview(request.message),
            "reason": str(exc),
        }, level="warning")
        return build_safe_planner_fallback(request)
    except OllamaServiceError as exc:
        raise IntentPlannerError(str(exc)) from exc

    return _validate_planner_result(raw_result, request)
