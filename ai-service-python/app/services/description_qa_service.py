from typing import Any

from app.schemas.agent import DescriptionQARequest, ReformulateAnswerRequest
from app.services.ollama_service import (
    OllamaJsonParseError,
    OllamaServiceError,
    answer_from_descriptions_with_ollama,
    reformulate_answer_from_facts,
)


class DescriptionQAError(Exception):
    pass


def reformulate_answer(request: ReformulateAnswerRequest) -> dict[str, Any]:
    if not request.extractedFacts:
        raise DescriptionQAError("No extracted facts to reformulate")
    try:
        raw = reformulate_answer_from_facts(
            request.userQuestion,
            request.extractedFacts,
            request_id=request.requestId,
            thread_id=request.threadId,
        )
        answer = str(raw.get("answerMarkdown") or "").strip() or None
        return {"answerMarkdown": answer}
    except (OllamaServiceError, OllamaJsonParseError) as exc:
        raise DescriptionQAError(str(exc)) from exc


def _validate_qa_result(raw: dict[str, Any], candidate_ids: list[str]) -> dict[str, Any]:
    selected_id = str(raw.get("selectedResourceId") or "").strip()
    if selected_id not in candidate_ids:
        selected_id = candidate_ids[0] if candidate_ids else None

    answer_markdown = str(raw.get("answerMarkdown") or "").strip() or None
    answerable = bool(raw.get("answerableFromDescription")) and bool(answer_markdown)

    return {
        "selectedResourceId": selected_id,
        "confidence": float(raw.get("confidence") or 0.0),
        "answerableFromDescription": answerable,
        "answerMarkdown": answer_markdown if answerable else None,
        "usedFacts": [str(f).strip() for f in (raw.get("usedFacts") or []) if str(f).strip()][:8],
        # When the model can answer from the description, no trusted file fetch is needed.
        "needsTrustedFileFetch": (not answerable) or bool(raw.get("needsTrustedFileFetch")),
    }


def answer_from_descriptions(request: DescriptionQARequest) -> dict[str, Any]:
    # WARNING: this answers FREELY from full catalog descriptions. It is NOT part of the trusted
    # banking answer path and is not called by the Node backend's resource-QA flow. Descriptions are
    # for retrieval/selection only; trusted banking facts must come from the trusted file + fact
    # extraction + reformulation (see reformulate_answer). Kept for diagnostics/experiments only.
    candidates = [c.model_dump() for c in request.candidates]
    candidate_ids = [c["id"] for c in candidates]

    if not candidates:
        raise DescriptionQAError("No candidates for description QA")

    try:
        raw = answer_from_descriptions_with_ollama(
            request.message,
            candidates,
            request_id=request.requestId,
            thread_id=request.threadId,
        )
        return _validate_qa_result(raw, candidate_ids)
    except (OllamaServiceError, OllamaJsonParseError) as exc:
        raise DescriptionQAError(str(exc)) from exc
