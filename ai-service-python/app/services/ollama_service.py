import json
import re
from typing import Any

import requests

from app.config import settings
from app.config.model_routing import ModelSelection, select_model
from app.prompts.ai_decision_prompt import build_ai_decision_prompt
from app.prompts.banking_intent_prompt import build_banking_intent_prompt
from app.prompts.intent_planner_prompt import build_intent_planner_prompt
from app.schemas.agent import AgentAnalyzeRequest
from app.services.architecture_logger import endTimer, logArchitecture, logError, startTimer


class OllamaServiceError(Exception):
    """Raised when Ollama is unavailable or returns unusable output."""


class OllamaJsonParseError(OllamaServiceError):
    """Raised when Ollama returns text that cannot be parsed as JSON."""

    def __init__(self, message: str, raw_output: str = ""):
        super().__init__(message)
        self.raw_output = raw_output
        self.is_json_parse_error = True


VISION_ENDPOINT = "/api/generate"
LOG_PREVIEW_LIMIT = 120
OLLAMA_TIMING_FIELDS = (
    "total_duration",
    "load_duration",
    "prompt_eval_count",
    "prompt_eval_duration",
    "eval_count",
    "eval_duration",
)


def _log_ollama(event: str, **fields: Any) -> None:
    if not settings.ARCHITECTURE_LOGS_ENABLED:
        return
    details = " ".join(f"{key}={value}" for key, value in fields.items())
    print(f"[ollama] {event}{(' ' + details) if details else ''}", flush=True)


def _routing_log_fields(selection: ModelSelection) -> dict[str, Any]:
    return {
        "model_routing_mode": selection.model_routing_mode,
        "selected_model": selection.selected_model,
        "selected_model_reason": selection.selected_model_reason,
        "vision_used": str(selection.vision_used).lower(),
    }


def _ollama_runtime_fields(selection: ModelSelection) -> dict[str, Any]:
    return {
        "model": selection.selected_model,
        "keep_alive": selection.selected_keep_alive,
        "unloadAfterResponse": str(settings.OLLAMA_UNLOAD_AFTER_RESPONSE).lower(),
        **_routing_log_fields(selection),
    }


def _ollama_timing_fields(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}

    return {
        field: payload[field]
        for field in OLLAMA_TIMING_FIELDS
        if payload.get(field) is not None
    }


def _build_generate_payload(payload: dict[str, Any], selection: ModelSelection) -> dict[str, Any]:
    return {
        **payload,
        "model": selection.selected_model,
        "keep_alive": selection.selected_keep_alive,
    }


def _unload_ollama_model(request_kind: str, selection: ModelSelection) -> None:
    if not settings.OLLAMA_UNLOAD_AFTER_RESPONSE:
        return

    response: requests.Response | None = None
    unload_payload = {
        "model": selection.selected_model,
        "prompt": "",
        "stream": False,
        "keep_alive": 0,
    }

    try:
        _log_ollama(
            "unload_request",
            request_kind=request_kind,
            endpoint=VISION_ENDPOINT,
            model=selection.selected_model,
            keep_alive=0,
            unloadAfterResponse="true",
            **_routing_log_fields(selection),
        )
        response = requests.post(
            f"{settings.OLLAMA_BASE_URL}{VISION_ENDPOINT}",
            json=unload_payload,
            timeout=10,
        )
        status_code = response.status_code
        payload = (
            response.json()
            if response.headers.get("content-type", "").startswith("application/json")
            else {}
        )
        _log_ollama(
            "unload_response",
            request_kind=request_kind,
            endpoint=VISION_ENDPOINT,
            model=selection.selected_model,
            keep_alive=0,
            status_code=status_code,
            **_routing_log_fields(selection),
            **_ollama_timing_fields(payload),
        )
        response.raise_for_status()
    except (ValueError, requests.RequestException) as exc:
        failed_response = getattr(exc, "response", None) or response
        _log_ollama(
            "unload_failed",
            request_kind=request_kind,
            endpoint=VISION_ENDPOINT,
            model=selection.selected_model,
            keep_alive=0,
            status_code=getattr(failed_response, "status_code", "none"),
            exception_type=exc.__class__.__name__,
            exception=_preview_text(exc),
            **_routing_log_fields(selection),
        )


def _post_generate_json(
    request_kind: str,
    payload: dict[str, Any],
    *,
    timeout: int,
    log_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    requires_vision = request_kind == "vision"
    selection = select_model(requires_vision=requires_vision)
    if requires_vision and not selection.direct_vision_supported:
        raise OllamaServiceError("Direct vision is unsupported when MODEL_ROUTING_MODE=text_only")

    request_payload = _build_generate_payload(payload, selection)
    runtime_field_keys = {
        "model",
        "keep_alive",
        "unloadAfterResponse",
        "model_routing_mode",
        "selected_model",
        "selected_model_reason",
        "vision_used",
    }
    fields = {
        key: value
        for key, value in (log_fields or {}).items()
        if key not in runtime_field_keys
    }
    response: requests.Response | None = None
    timer = startTimer(request_kind)

    try:
        logArchitecture("ollama_call_started", {
            "requestId": fields.get("requestId"),
            "threadId": fields.get("threadId"),
            "requestKind": request_kind,
            "endpoint": VISION_ENDPOINT,
            "model": selection.selected_model,
            "mode": "vision" if selection.vision_used else "text",
            "promptType": request_kind,
            "imageCount": fields.get("image_count"),
            "selectedPages": fields.get("selected_pages"),
            **_routing_log_fields(selection),
        })
        _log_ollama(
            f"{request_kind}_request",
            endpoint=VISION_ENDPOINT,
            **_ollama_runtime_fields(selection),
            **fields,
        )
        response = requests.post(
            f"{settings.OLLAMA_BASE_URL}{VISION_ENDPOINT}",
            json=request_payload,
            timeout=timeout,
        )
        _log_ollama(
            f"{request_kind}_response",
            endpoint=VISION_ENDPOINT,
            status_code=response.status_code,
            **_ollama_runtime_fields(selection),
            **fields,
        )
        response.raise_for_status()
        response_payload = response.json()
        _log_ollama(
            f"{request_kind}_timing",
            endpoint=VISION_ENDPOINT,
            **_ollama_runtime_fields(selection),
            **fields,
            **_ollama_timing_fields(response_payload),
        )
        logArchitecture("ollama_call_finished", {
            "requestId": fields.get("requestId"),
            "threadId": fields.get("threadId"),
            "requestKind": request_kind,
            "endpoint": VISION_ENDPOINT,
            "model": selection.selected_model,
            "mode": "vision" if selection.vision_used else "text",
            "latencyMs": endTimer(timer),
            "statusCode": response.status_code,
            "parsing": "success",
            **_routing_log_fields(selection),
            **_ollama_timing_fields(response_payload),
        })
        return response_payload
    except requests.RequestException as exc:
        failed_response = getattr(exc, "response", None) or response
        _log_ollama(
            f"{request_kind}_request_failed",
            endpoint=VISION_ENDPOINT,
            status_code=getattr(failed_response, "status_code", "none"),
            exception_type=exc.__class__.__name__,
            exception=_preview_text(exc),
            **_ollama_runtime_fields(selection),
            **fields,
        )
        logError("ollama_call_failed", exc, {
            "requestId": fields.get("requestId"),
            "threadId": fields.get("threadId"),
            "requestKind": request_kind,
            "endpoint": VISION_ENDPOINT,
            "model": selection.selected_model,
            "latencyMs": endTimer(timer),
            "parsing": "failure",
            **_routing_log_fields(selection),
        })
        raise
    except ValueError as exc:
        _log_ollama(
            f"{request_kind}_response_json_failed",
            endpoint=VISION_ENDPOINT,
            status_code=getattr(response, "status_code", "none"),
            exception_type=exc.__class__.__name__,
            exception=_preview_text(exc),
            **_ollama_runtime_fields(selection),
            **fields,
        )
        logError("ollama_json_parse_failed", exc, {
            "requestId": fields.get("requestId"),
            "threadId": fields.get("threadId"),
            "requestKind": request_kind,
            "endpoint": VISION_ENDPOINT,
            "model": selection.selected_model,
            "latencyMs": endTimer(timer),
            "parsing": "failure",
            **_routing_log_fields(selection),
        })
        raise
    finally:
        if response is not None:
            _unload_ollama_model(request_kind, selection)


def _preview_text(value: Any, limit: int = LOG_PREVIEW_LIMIT) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    return text[:limit]


def _strip_thinking_blocks(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()


def _parse_json_text(text: str) -> dict[str, Any]:
    parsed = json.loads(text)

    if not isinstance(parsed, dict):
        raise OllamaServiceError("Ollama JSON response must be an object")

    return parsed


def _json_from_fenced_block(text: str) -> dict[str, Any] | None:
    for match in re.finditer(
        r"```(?:json)?\s*(.*?)```",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    ):
        block = match.group(1).strip()
        if not block:
            continue
        try:
            return _parse_json_text(block)
        except (json.JSONDecodeError, OllamaServiceError):
            continue
    return None


def _balanced_json_candidates(text: str) -> list[str]:
    candidates: list[str] = []
    start = None
    depth = 0
    in_string = False
    escaped = False

    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
            continue

        if char == "{":
            if depth == 0:
                start = index
            depth += 1
            continue

        if char == "}" and depth:
            depth -= 1
            if depth == 0 and start is not None:
                candidates.append(text[start:index + 1])
                start = None

    return candidates


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned_text = _strip_thinking_blocks(text)

    try:
        return _parse_json_text(cleaned_text)
    except json.JSONDecodeError:
        pass

    fenced_json = _json_from_fenced_block(cleaned_text)
    if fenced_json is not None:
        return fenced_json

    for candidate in _balanced_json_candidates(cleaned_text):
        try:
            return _parse_json_text(candidate)
        except (json.JSONDecodeError, OllamaServiceError):
            continue

    raise OllamaJsonParseError("Ollama response did not contain valid JSON", text)


def _extract_json_object_for_vision(
    text: str,
    *,
    log_failure: bool = False,
) -> dict[str, Any] | None:
    if not _strip_thinking_blocks(text):
        return None

    try:
        return _extract_json_object(text)
    except (json.JSONDecodeError, OllamaServiceError) as exc:
        if log_failure:
            _log_ollama(
                "vision_parse_failed",
                error_type=exc.__class__.__name__,
                error=_preview_text(exc),
            )
        return None


def _markdown_result_from_text(text: str) -> dict[str, Any]:
    markdown = _strip_thinking_blocks(text)
    if not markdown:
        raise OllamaServiceError("empty_ollama_response")

    return {
        "markdown": markdown,
        "assistantMessage": markdown,
        "documentType": "unknown",
        "documentTypeDetected": "unknown",
        "documentMatchesRequest": True,
        "suggestedAction": None,
        "extractedFields": {},
        "tables": [],
        "warnings": [],
        "confidence": 0.5,
    }


def _payload_keys(payload: Any) -> str:
    if not isinstance(payload, dict):
        return type(payload).__name__
    return ",".join(sorted(str(key) for key in payload.keys()))


def _max_predict(default: int) -> int:
    configured = getattr(settings, "MAX_AI_RESPONSE_TOKENS", default)
    try:
        configured = int(configured)
    except (TypeError, ValueError):
        configured = default
    return max(1, min(default, configured))


def _extract_ollama_text(payload: Any) -> tuple[str | None, str]:
    if not isinstance(payload, dict):
        return None, "none"

    response_text = payload.get("response")
    if isinstance(response_text, str):
        return response_text, "response"

    message = payload.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content, "message.content"

    return None, "none"


def _is_json_only(text: str) -> bool:
    try:
        _parse_json_text(_strip_thinking_blocks(text))
        return True
    except (json.JSONDecodeError, OllamaServiceError):
        return False


def _remove_json_artifacts(text: str) -> str:
    cleaned_text = _strip_thinking_blocks(text)
    without_fenced_json = re.sub(
        r"```(?:json)?\s*\{.*?\}\s*```",
        "",
        cleaned_text,
        flags=re.DOTALL | re.IGNORECASE,
    ).strip()

    if not without_fenced_json:
        return ""

    for candidate in _balanced_json_candidates(without_fenced_json):
        start = without_fenced_json.find(candidate)
        if start < 0:
            continue
        before = without_fenced_json[:start].strip()
        after = without_fenced_json[start + len(candidate):].strip()
        if before and not after:
            return before
        if not before and not after:
            return ""

    return without_fenced_json


def _vision_result_from_text(text: str) -> dict[str, Any]:
    parsed = _extract_json_object_for_vision(text)
    markdown = _remove_json_artifacts(text)

    if parsed is None:
        return _markdown_result_from_text(markdown or text)

    if _is_json_only(text):
        return parsed

    result = _markdown_result_from_text(markdown or parsed.get("markdown") or text)
    for key, value in parsed.items():
        if key in {"markdown", "assistantMessage"} and markdown:
            continue
        result[key] = value
    if markdown:
        result["markdown"] = markdown
        result["assistantMessage"] = markdown
    return result


def analyze_with_ollama(request: AgentAnalyzeRequest) -> dict[str, Any]:
    prompt = build_banking_intent_prompt(request)

    try:
        payload = _post_generate_json(
            "analysis",
            {
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": 0,
                    "num_predict": _max_predict(300),
                },
            },
            timeout=20,
            log_fields={
                "requestId": request.requestId,
                "threadId": request.threadId,
                "prompt_length": len(prompt or ""),
                "timeout_seconds": 20,
            },
        )
    except requests.RequestException as exc:
        raise OllamaServiceError("Ollama is unavailable") from exc

    response_text = payload.get("response")

    if not isinstance(response_text, str):
        raise OllamaServiceError("Ollama response text is missing")

    return _extract_json_object(response_text)


def decide_with_ollama(request: AgentAnalyzeRequest) -> dict[str, Any]:
    prompt = build_ai_decision_prompt(request)

    try:
        payload = _post_generate_json(
            "decision",
            {
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": 0,
                    "num_predict": _max_predict(450),
                },
            },
            timeout=20,
            log_fields={
                "requestId": request.requestId,
                "threadId": request.threadId,
                "prompt_length": len(prompt or ""),
                "timeout_seconds": 20,
            },
        )
    except requests.RequestException as exc:
        raise OllamaServiceError("Ollama is unavailable") from exc

    response_text = payload.get("response")

    if not isinstance(response_text, str):
        raise OllamaServiceError("Ollama response text is missing")

    return _extract_json_object(response_text)


def plan_intent_with_ollama(request: AgentAnalyzeRequest) -> dict[str, Any]:
    prompt = build_intent_planner_prompt(request)

    try:
        payload = _post_generate_json(
            "intent_planner",
            {
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": 0,
                    "num_predict": _max_predict(350),
                },
            },
            timeout=20,
            log_fields={
                "requestId": request.requestId,
                "threadId": request.threadId,
                "prompt_length": len(prompt or ""),
                "timeout_seconds": 20,
            },
        )
    except requests.RequestException as exc:
        raise OllamaServiceError("Ollama is unavailable") from exc

    response_text = payload.get("response")

    if not isinstance(response_text, str):
        raise OllamaServiceError("Ollama response text is missing")

    logArchitecture("planner_raw_output_received", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "responseLength": len(response_text or ""),
    })

    try:
        parsed = _extract_json_object(response_text)
    except OllamaJsonParseError as exc:
        logArchitecture("planner_json_extract_failed", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "responseLength": len(response_text or ""),
            "error": str(exc),
        }, level="warning")
        raise

    logArchitecture("planner_json_extract_success", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "intentType": parsed.get("intentType") or parsed.get("mode"),
        "resourceQueryLength": len(str(parsed.get("resourceQuery") or parsed.get("resourceSearchQuery") or "")),
        "userGoalLength": len(str(parsed.get("userGoal") or "")),
        "missingFieldCount": len(parsed.get("missingFields") or []) if isinstance(parsed.get("missingFields"), list) else 0,
    })
    return parsed


def rerank_resources_with_ollama(
    message: str,
    candidates: list[dict[str, Any]],
    *,
    request_id: str | None = None,
    thread_id: str | None = None,
) -> dict[str, Any]:
    candidates_text = "\n".join(
        f"ID: {c.get('id', '')}\n"
        f"  Title: {c.get('title', '')}\n"
        f"  Category: {c.get('category') or ''}\n"
        f"  Description: {c.get('description') or ''}\n"
        f"  Example queries: {'; '.join(c.get('exampleQueries') or [])}\n"
        f"  Intents: {', '.join(c.get('intents') or [])}\n"
        f"  Related actions: {', '.join(c.get('relatedActions') or [])}"
        for c in candidates
    )
    prompt = (
        f"You are a resource selection assistant for a banking app. "
        f"Given the user's exact message, pick the single best matching resource from the list.\n\n"
        f"User message: \"{message}\"\n\n"
        f"Candidates:\n{candidates_text}\n\n"
        f"Rules:\n"
        f"- Exact entity, name, merchant, provider, or service mentions in the message must strongly favour that candidate.\n"
        f"- Specific matches outrank generic category matches.\n"
        f"- Generic words like payment, card, receipt, alert, account, transfer must NOT override a more specific entity match.\n\n"
        f"Respond with valid JSON only:\n"
        f'{{\"chosenId\": \"<id>\", \"reason\": \"<one short sentence>\", \"confidence\": 0.0}}'
    )

    try:
        payload = _post_generate_json(
            "reranker",
            {
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": 0,
                    "num_predict": _max_predict(120),
                },
            },
            timeout=20,
            log_fields={
                "requestId": request_id,
                "threadId": thread_id,
                "candidateCount": len(candidates),
                "prompt_length": len(prompt),
                "timeout_seconds": 20,
            },
        )
    except requests.RequestException as exc:
        raise OllamaServiceError("Ollama is unavailable for reranking") from exc

    response_text, _ = _extract_ollama_text(payload)
    if not isinstance(response_text, str):
        raise OllamaServiceError("Ollama reranker response text is missing")

    return _extract_json_object(response_text)


def answer_from_descriptions_with_ollama(
    message: str,
    candidates: list[dict[str, Any]],
    *,
    request_id: str | None = None,
    thread_id: str | None = None,
) -> dict[str, Any]:
    # ⚠️ Diagnostics-only. Answers FREELY from full catalog descriptions and is NOT used for trusted
    # banking facts. The production flow uses reformulate_answer_from_facts on EXTRACTED facts only.
    # Only id/title/description are sent — file metadata is never used as reasoning context.
    candidates_text = "\n".join(
        f"ID: {c.get('id', '')}\n"
        f"  Title: {c.get('title', '')}\n"
        f"  Description: {c.get('description') or ''}"
        for c in candidates
    )
    prompt = (
        "You are a banking assistant. Answer the user's question using ONLY the resource "
        "descriptions below. Pick the single most relevant resource.\n\n"
        f"User question: \"{message}\"\n\n"
        f"Resources:\n{candidates_text}\n\n"
        "Rules:\n"
        "- Answer ONLY the user's specific question in one short sentence. Do NOT summarize, list, "
        "or restate the resource. Do NOT say 'I found', 'This resource is', or mention the catalog/description.\n"
        "- Use ONLY facts copied from the selected description. Never invent values.\n"
        "- When a description contains rows of branch/service/hour facts, match the requested service "
        "to the row that contains that service. Do NOT use the nearest or default branch unless the "
        "user explicitly asks for the nearest/closest/default branch.\n"
        "  Example: for a question about SME support or premium desk, answer with the branch whose row "
        "lists that service, not the nearest/default branch.\n"
        "- Bold every important value with **markdown**: branch/entity names, service names, dates, "
        "amounts, hours, statuses, payment obligations. An answer with no bold is invalid.\n"
        "- usedFacts must list the exact short fact strings (copied from the description) that justify "
        "the answer. It must be non-empty when answerableFromDescription is true.\n"
        "- If the descriptions do NOT contain enough facts to answer, set answerableFromDescription "
        "to false, needsTrustedFileFetch to true, and answerMarkdown to an empty string.\n\n"
        "Respond with valid JSON only:\n"
        '{"selectedResourceId": "<id>", "confidence": 0.0, "answerableFromDescription": true, '
        '"answerMarkdown": "<one-sentence answer with **bold** values>", '
        '"usedFacts": ["exact short fact from description"], '
        '"needsTrustedFileFetch": false}'
    )

    try:
        payload = _post_generate_json(
            "reranker",
            {
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": 0,
                    "num_predict": _max_predict(400),
                },
            },
            timeout=30,
            log_fields={
                "requestId": request_id,
                "threadId": thread_id,
                "candidateCount": len(candidates),
                "prompt_length": len(prompt),
                "timeout_seconds": 30,
            },
        )
    except requests.RequestException as exc:
        raise OllamaServiceError("Ollama is unavailable for description QA") from exc

    response_text, _ = _extract_ollama_text(payload)
    if not isinstance(response_text, str):
        raise OllamaServiceError("Ollama description QA response text is missing")

    return _extract_json_object(response_text)


def reformulate_answer_from_facts(
    user_question: str,
    extracted_facts: dict[str, Any],
    *,
    request_id: str | None = None,
    thread_id: str | None = None,
) -> dict[str, Any]:
    # The model receives ONLY the pre-extracted facts (never the full multi-row description), so it
    # cannot mix rows. Its only job is natural wording.
    facts_text = json.dumps(extracted_facts, ensure_ascii=False)
    prompt = (
        "You are a banking assistant. Reformulate the given FACTS into one natural sentence that "
        "answers the user's question. You may ONLY use the values in FACTS.\n\n"
        f"User question: \"{user_question}\"\n"
        f"FACTS (the only allowed values): {facts_text}\n\n"
        "Rules:\n"
        "- Use ONLY values present in FACTS. Never add a branch, service, hour, address, or phone "
        "that is not in FACTS.\n"
        "- Answer the specific question. Do not list facts the user did not ask for.\n"
        "- Do not include the support phone unless the question asks for it.\n"
        "- Do not mention nearest/default branch.\n"
        "- Bold every important value with **markdown** (branch name, service names, hours).\n"
        "- One sentence. Do not say 'I found' or mention any catalog/description.\n\n"
        "Respond with valid JSON only:\n"
        '{"answerMarkdown": "<one sentence with **bold** values from FACTS>"}'
    )

    try:
        payload = _post_generate_json(
            "reranker",
            {
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {"temperature": 0, "num_predict": _max_predict(200)},
            },
            timeout=20,
            log_fields={
                "requestId": request_id,
                "threadId": thread_id,
                "prompt_length": len(prompt),
                "timeout_seconds": 20,
            },
        )
    except requests.RequestException as exc:
        raise OllamaServiceError("Ollama is unavailable for reformulation") from exc

    response_text, _ = _extract_ollama_text(payload)
    if not isinstance(response_text, str):
        raise OllamaServiceError("Ollama reformulation response text is missing")

    return _extract_json_object(response_text)


def _request_vision_generate(
    prompt: str,
    images: list[str],
    attempt: str,
    attempt_number: int,
    log_context: dict[str, Any] | None = None,
) -> str:
    raise OllamaServiceError("vision_model_disabled")

    context = log_context or {}
    selection = select_model(requires_vision=True)
    timeout_seconds = max(1, settings.VISION_REQUEST_TIMEOUT_MS / 1000)
    is_image_payload = bool(context.get("is_image_payload"))
    try:
        _num_predict_override = context.get("num_predict")
        _num_predict_default = 700 if is_image_payload else 1800
        request_payload = {
            "prompt": prompt,
            "images": images,
            "stream": False,
            "options": {
                "temperature": 0.0 if is_image_payload else 0.2,
                "num_predict": _max_predict(_num_predict_override if _num_predict_override else _num_predict_default),
            },
        }
        # Diagnostic: log Ollama request shape (no base64/prompt content)
        print(
            f"[vision-diag] ollama_request_shape"
            f" model={selection.selected_model}"
            f" endpoint={settings.OLLAMA_BASE_URL}{VISION_ENDPOINT}"
            f" image_count={len(images)}"
            f" image_base64_length={len(images[0]) if images else 0}"
            f" timeout_seconds={timeout_seconds}"
            f" think=none"
            f" format=none"
            f" temperature={request_payload['options']['temperature']}"
            f" num_predict={request_payload['options']['num_predict']}"
            f" num_predict_override={_num_predict_override}"
            f" attempt={attempt}",
            flush=True,
        )

        payload = _post_generate_json(
            "vision",
            request_payload,
            timeout=timeout_seconds,
            log_fields={
                "requestId": context.get("requestId"),
                "threadId": context.get("threadId"),
                "selected_pages": context.get("selected_pages"),
                "attempt": attempt,
                "attempt_number": attempt_number,
                "image_count": len(images),
                "prompt_length": len(prompt or ""),
                "timeout_seconds": timeout_seconds,
                "selected_model": selection.selected_model,
                "ocrTextLength": context.get("ocr_text_length"),
            },
        )
    except requests.Timeout as exc:
        print(
            f"[vision-diag] ollama_timeout"
            f" model={selection.selected_model}"
            f" timeout_seconds={timeout_seconds}"
            f" attempt={attempt}",
            flush=True,
        )
        _log_ollama(
            "vision_timeout",
            attempt=attempt,
            attempt_number=attempt_number,
            model=selection.selected_model,
            image_count=len(images),
            endpoint=VISION_ENDPOINT,
            prompt_length=len(prompt or ""),
            timeout_seconds=timeout_seconds,
            exception_type=exc.__class__.__name__,
            vision_timeout=True,
            **_routing_log_fields(selection),
        )
        raise OllamaServiceError("vision_timeout") from exc
    except requests.RequestException as exc:
        failed_resp = getattr(exc, "response", None)
        print(
            f"[vision-diag] ollama_request_error"
            f" model={selection.selected_model}"
            f" exception_type={exc.__class__.__name__}"
            f" http_status={getattr(failed_resp, 'status_code', 'none')}"
            f" error={str(exc)[:200]}"
            f" attempt={attempt}",
            flush=True,
        )
        _log_ollama(
            "vision_unavailable",
            attempt=attempt,
            attempt_number=attempt_number,
            model=selection.selected_model,
            image_count=len(images),
            endpoint=VISION_ENDPOINT,
            prompt_length=len(prompt or ""),
            exception_type=exc.__class__.__name__,
            exception=_preview_text(exc),
            **_routing_log_fields(selection),
        )
        raise OllamaServiceError("Ollama vision model is unavailable") from exc
    except ValueError as exc:
        raise OllamaServiceError("Ollama response envelope was not JSON") from exc

    response_text, content_field = _extract_ollama_text(payload)
    thinking_text = payload.get("thinking") or ""
    _log_ollama(
        "vision_payload",
        attempt=attempt,
        attempt_number=attempt_number,
        model=selection.selected_model,
        endpoint=VISION_ENDPOINT,
        content_field=content_field,
        content_length=len(response_text or ""),
        thinking_length=len(thinking_text),
        response_keys=_payload_keys(payload),
        **_routing_log_fields(selection),
    )


    print(
        f"[vision-diag] ollama_response_received"
        f" model={selection.selected_model}"
        f" content_field={content_field}"
        f" response_length={len(response_text or '')}"
        f" thinking_length={len(thinking_text)}"
        f" done_reason={payload.get('done_reason', 'unknown')}"
        f" eval_count={payload.get('eval_count', 'unknown')}"
        f" error={payload.get('error', 'none')}"
        f" payload_keys={_payload_keys(payload)}"
        f" attempt={attempt}",
        flush=True,
    )

    if not isinstance(response_text, str) or not _strip_thinking_blocks(response_text):
        is_thinking_overflow = (
            bool(thinking_text)
            and not (response_text or "").strip()
            and payload.get("done_reason") == "length"
        )
        print(
            f"[vision-diag] ollama_empty_response"
            f" model={selection.selected_model}"
            f" response_type={type(response_text).__name__}"
            f" response_length={len(response_text or '')}"
            f" thinking_length={len(thinking_text)}"
            f" stripped_length={len(_strip_thinking_blocks(response_text or ''))}"
            f" done_reason={payload.get('done_reason', 'unknown')}"
            f" is_thinking_overflow={is_thinking_overflow}"
            f" attempt={attempt}",
            flush=True,
        )
        _log_ollama(
            "vision_empty_response",
            attempt=attempt,
            attempt_number=attempt_number,
            model=selection.selected_model,
            endpoint=VISION_ENDPOINT,
            image_count=len(images),
            prompt_length=len(prompt or ""),
            status_code="unknown",
            response_keys=_payload_keys(payload),
            content_field=content_field,
            **_routing_log_fields(selection),
        )
        raise OllamaServiceError("thinking_overflow" if is_thinking_overflow else "empty_ollama_response")

    return response_text


def analyze_vision_images_with_ollama(
    prompt: str,
    images: list[str],
    retry_attempts: list[dict[str, Any]] | None = None,
    log_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    raise OllamaServiceError("vision_model_disabled")

    if not images:
        raise OllamaServiceError("No rendered document images were provided")

    attempts = [
        {
            "label": "primary",
            "prompt": prompt,
            "images": images,
        },
        *(retry_attempts or []),
    ]

    last_error: OllamaServiceError | None = None
    for attempt_number, attempt in enumerate(attempts, start=1):
        attempt_label = str(attempt.get("label") or "retry")
        attempt_prompt = str(attempt.get("prompt") or prompt)
        attempt_images = attempt.get("images") or images
        attempt_context = {**(log_context or {}), **(attempt.get("context") or {})}
        try:
            response_text = _request_vision_generate(
                attempt_prompt,
                attempt_images,
                attempt_label,
                attempt_number,
                attempt_context,
            )
        except OllamaServiceError as exc:
            last_error = exc
            if str(exc) in ("empty_ollama_response", "thinking_overflow"):
                continue
            raise

        parsed = _extract_json_object_for_vision(response_text)
        result = _vision_result_from_text(response_text)
        _log_ollama(
            "vision_parse",
            attempt=attempt_label,
            result="json" if parsed else "markdown",
        )
        return result

    raise last_error or OllamaServiceError("empty_ollama_response")
