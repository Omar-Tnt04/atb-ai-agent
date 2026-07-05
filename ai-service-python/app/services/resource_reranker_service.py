from typing import Any

from app.schemas.agent import ResourceRerankRequest
from app.services.ollama_service import OllamaJsonParseError, OllamaServiceError, rerank_resources_with_ollama


class ResourceRerankError(Exception):
    pass


def _validate_rerank_result(
    raw: dict[str, Any],
    candidate_ids: list[str],
) -> dict[str, Any]:
    chosen_id = str(raw.get("chosenId") or "").strip()
    if not chosen_id or chosen_id not in candidate_ids:
        # Fall back to first candidate
        chosen_id = candidate_ids[0] if candidate_ids else ""
    return {
        "chosenId": chosen_id,
        "reason": str(raw.get("reason") or "").strip() or None,
        "confidence": float(raw.get("confidence") or 0.0),
    }


def rerank_resources(request: ResourceRerankRequest) -> dict[str, Any]:
    candidates = [c.model_dump() for c in request.candidates]
    candidate_ids = [c["id"] for c in candidates]

    if not candidates:
        raise ResourceRerankError("No candidates to rerank")

    if len(candidates) == 1:
        return {
            "chosenId": candidate_ids[0],
            "reason": "single candidate",
            "confidence": 1.0,
        }

    try:
        raw = rerank_resources_with_ollama(
            request.message,
            candidates,
            request_id=request.requestId,
            thread_id=request.threadId,
        )
        return _validate_rerank_result(raw, candidate_ids)
    except (OllamaServiceError, OllamaJsonParseError) as exc:
        raise ResourceRerankError(str(exc)) from exc
