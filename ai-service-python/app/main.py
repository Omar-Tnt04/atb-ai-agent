import json

from fastapi import FastAPI, HTTPException

from app.config import settings
from app.config.model_routing import select_model
from app.schemas.agent import (
    AgentAnalyzeRequest,
    AgentAnalyzeResponse,
    AgentDecisionResponse,
    DescriptionQARequest,
    DescriptionQAResponse,
    IntentPlannerResponse,
    ReformulateAnswerRequest,
    ReformulateAnswerResponse,
    ResourceRerankRequest,
    ResourceRerankResponse,
    VisionDocumentAnalyzeRequest,
)
from app.services.decision_service import decide_message
from app.services.description_qa_service import (
    DescriptionQAError,
    answer_from_descriptions,
    reformulate_answer,
)
from app.services.intent_planner_service import IntentPlannerError, plan_intent
from app.services.intent_service import analyze_message
from app.services.resource_reranker_service import ResourceRerankError, rerank_resources
from app.services.vision_document_service import (
    VisionDocumentError,
    analyze_vision_document,
)
from app.services.architecture_logger import (
    endTimer,
    logArchitecture,
    logError,
    message_preview,
    startTimer,
)

_OCR_BUILD_TS = "2026-06-13T00:00:00"
print(f"[ocr-debug] python OCR service version: {_OCR_BUILD_TS}", flush=True)

app = FastAPI(
    title="ATB AI Banking Agent AI Service",
    version="0.1.0",
)


def _routing_log_fields(selection):
    return {
        "model_routing_mode": selection.model_routing_mode,
        "selected_model": selection.selected_model,
        "selected_model_reason": selection.selected_model_reason,
        "vision_used": selection.vision_used,
    }


def _request_context_chars(request, exclude: set[str] | None = None) -> int:
    try:
        data = request.model_dump(exclude=exclude or set())
        return len(json.dumps(data, ensure_ascii=False))
    except Exception:
        return 0


@app.on_event("startup")
def log_active_ai_model():
    import os
    import sys

    if os.environ.get("DEV_VERBOSE", "").lower() == "true":
        _pfx = "[ai:startup]"
        _w = 17
        tess = "(not configured)"
        try:
            import pytesseract
            tess = getattr(pytesseract, "tesseract_cmd", "(unknown)")
        except Exception:
            pass
        print(f"{_pfx}", flush=True)
        print(f"{_pfx}[RUNTIME INFO]", flush=True)
        print(f"{_pfx}  {'sys.executable'.ljust(_w)}: {sys.executable}", flush=True)
        print(f"{_pfx}  {'sys.prefix'.ljust(_w)}: {sys.prefix}", flush=True)
        print(f"{_pfx}  {'cwd'.ljust(_w)}: {os.getcwd()}", flush=True)
        print(f"{_pfx}  {'tesseract_cmd'.ljust(_w)}: {tess}", flush=True)
        print(f"{_pfx}", flush=True)

    text_selection = select_model(requires_vision=False)
    print(
        "ATB AI service using model routing "
        f"mode={settings.MODEL_ROUTING_MODE} at {settings.OLLAMA_BASE_URL} "
        f"text_model={text_selection.selected_model} "
        f"text_keep_alive={text_selection.selected_keep_alive} "
        f"vision_runtime=disabled "
        f"unloadAfterResponse={str(settings.OLLAMA_UNLOAD_AFTER_RESPONSE).lower()}"
    )


@app.get("/health")
def health_check():
    return {
        "success": True,
        "service": "ATB AI Banking Agent AI Service",
        "status": "running",
    }


@app.post("/agent/analyze", response_model=AgentAnalyzeResponse)
def analyze_agent_message(request: AgentAnalyzeRequest):
    timer = startTimer("analyze")
    routing = select_model(requires_vision=False)
    context_chars_before = _request_context_chars(request)
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "analyze",
        "model": routing.selected_model,
        "mode": "text",
        "messagePreview": message_preview(request.message),
        **_routing_log_fields(routing),
    })
    try:
        data = analyze_message(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "analyze",
            "model": routing.selected_model,
            "mode": "text",
            "latencyMs": endTimer(timer),
            "jsonValidation": "success",
            "parsing": "success",
            "intent": data.get("intent"),
            **_routing_log_fields(routing),
        })
        return {
            "success": True,
            "data": data,
        }
    except Exception as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "analyze",
            "latencyMs": endTimer(timer),
            "jsonValidation": "failure",
        })
        raise HTTPException(
            status_code=500,
            detail="Unable to analyze message",
        ) from exc
    finally:
        logArchitecture("request_temp_cleanup_done", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "analyze",
            "request_temp_cleanup_done": True,
            "context_chars_before": context_chars_before,
            "context_chars_after": 0,
        })


@app.post("/agent/decide", response_model=AgentDecisionResponse)
def decide_agent_message(request: AgentAnalyzeRequest):
    timer = startTimer("decide")
    routing = select_model(requires_vision=False)
    context_chars_before = _request_context_chars(request)
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "decide",
        "model": routing.selected_model,
        "mode": "text",
        "messagePreview": message_preview(request.message),
        **_routing_log_fields(routing),
    })
    try:
        data = decide_message(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "decide",
            "model": routing.selected_model,
            "mode": "text",
            "latencyMs": endTimer(timer),
            "jsonValidation": "success",
            "parsing": "success",
            "decision": data.get("decision"),
            "intent": data.get("intent"),
            **_routing_log_fields(routing),
        })
        return {
            "success": True,
            "data": data,
        }
    except Exception as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "decide",
            "latencyMs": endTimer(timer),
            "jsonValidation": "failure",
        })
        raise HTTPException(
            status_code=500,
            detail="Unable to decide message",
        ) from exc
    finally:
        logArchitecture("request_temp_cleanup_done", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "decide",
            "request_temp_cleanup_done": True,
            "context_chars_before": context_chars_before,
            "context_chars_after": 0,
        })


@app.post("/agent/plan", response_model=IntentPlannerResponse)
def plan_agent_message(request: AgentAnalyzeRequest):
    timer = startTimer("planner")
    routing = select_model(requires_vision=False)
    context_chars_before = _request_context_chars(request)
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "plan",
        "model": routing.selected_model,
        "mode": "text",
        "messageLength": len(request.message or ""),
        **_routing_log_fields(routing),
    })
    try:
        data = plan_intent(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "plan",
            "model": routing.selected_model,
            "mode": "text",
            "latencyMs": endTimer(timer),
            "jsonValidation": "success",
            "parsing": "success",
            "intentType": data.get("intentType"),
            "resourceNeed": data.get("resourceNeed"),
            "resourceQueryLength": len(str(data.get("resourceQuery") or "")),
            "userGoalLength": len(str(data.get("userGoal") or "")),
            "missingFieldCount": len(data.get("missingFields") or []),
            **_routing_log_fields(routing),
        })
        return {
            "success": True,
            "data": data,
        }
    except IntentPlannerError as exc:
        logError("python_planner_json_parse_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "plan",
            "latencyMs": endTimer(timer),
            "jsonValidation": "failure",
        })
        raise HTTPException(
            status_code=422,
            detail="planner_json_parse_failed",
        ) from exc
    except Exception as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "plan",
            "latencyMs": endTimer(timer),
            "jsonValidation": "failure",
        })
        raise HTTPException(
            status_code=500,
            detail="Unable to plan message",
        ) from exc
    finally:
        logArchitecture("request_temp_cleanup_done", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "plan",
            "request_temp_cleanup_done": True,
            "context_chars_before": context_chars_before,
            "context_chars_after": 0,
        })


@app.post("/agent/rerank-resources", response_model=ResourceRerankResponse)
def rerank_agent_resources(request: ResourceRerankRequest):
    timer = startTimer("reranker")
    routing = select_model(requires_vision=False)
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "rerank-resources",
        "model": routing.selected_model,
        "mode": "text",
        "candidateCount": len(request.candidates),
        **_routing_log_fields(routing),
    })
    try:
        data = rerank_resources(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "rerank-resources",
            "model": routing.selected_model,
            "latencyMs": endTimer(timer),
            "chosenId": data.get("chosenId"),
            **_routing_log_fields(routing),
        })
        return {"success": True, "data": data}
    except ResourceRerankError as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "rerank-resources",
            "latencyMs": endTimer(timer),
        })
        raise HTTPException(status_code=500, detail="Unable to rerank resources") from exc
    except Exception as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "rerank-resources",
            "latencyMs": endTimer(timer),
        })
        raise HTTPException(status_code=500, detail="Unable to rerank resources") from exc


# ⚠️ Diagnostics-only endpoint. NOT part of the trusted banking answer path. It answers freely from
# full catalog descriptions; the Node backend does NOT call it. Descriptions are for retrieval only.
@app.post("/agent/answer-from-descriptions", response_model=DescriptionQAResponse)
def answer_from_descriptions_endpoint(request: DescriptionQARequest):
    timer = startTimer("description_qa")
    routing = select_model(requires_vision=False)
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "answer-from-descriptions",
        "model": routing.selected_model,
        "mode": "text",
        "candidateCount": len(request.candidates),
        **_routing_log_fields(routing),
    })
    try:
        data = answer_from_descriptions(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "answer-from-descriptions",
            "model": routing.selected_model,
            "latencyMs": endTimer(timer),
            "selectedResourceId": data.get("selectedResourceId"),
            "answerableFromDescription": data.get("answerableFromDescription"),
            **_routing_log_fields(routing),
        })
        return {"success": True, "data": data}
    except DescriptionQAError as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "answer-from-descriptions",
            "latencyMs": endTimer(timer),
        })
        raise HTTPException(status_code=500, detail="Unable to answer from descriptions") from exc
    except Exception as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "answer-from-descriptions",
            "latencyMs": endTimer(timer),
        })
        raise HTTPException(status_code=500, detail="Unable to answer from descriptions") from exc


@app.post("/agent/reformulate-answer", response_model=ReformulateAnswerResponse)
def reformulate_answer_endpoint(request: ReformulateAnswerRequest):
    timer = startTimer("reformulate")
    routing = select_model(requires_vision=False)
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "reformulate-answer",
        "model": routing.selected_model,
        "mode": "text",
        **_routing_log_fields(routing),
    })
    try:
        data = reformulate_answer(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "reformulate-answer",
            "model": routing.selected_model,
            "latencyMs": endTimer(timer),
            **_routing_log_fields(routing),
        })
        return {"success": True, "data": data}
    except DescriptionQAError as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "reformulate-answer",
            "latencyMs": endTimer(timer),
        })
        raise HTTPException(status_code=500, detail="Unable to reformulate answer") from exc
    except Exception as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "reformulate-answer",
            "latencyMs": endTimer(timer),
        })
        raise HTTPException(status_code=500, detail="Unable to reformulate answer") from exc


@app.post("/agent/analyze-vision-document", response_model=AgentAnalyzeResponse)
def analyze_agent_vision_document(request: VisionDocumentAnalyzeRequest):
    routing = select_model(requires_vision=False)
    context_chars_before = _request_context_chars(request, exclude={"pdfBase64"})
    if settings.ARCHITECTURE_LOGS_ENABLED:
        print(
            "[ocr] endpoint_received "
            f"source={request.source} "
            f"mime_type={request.mimeType or 'unknown'} "
            f"payload_length={len(request.pdfBase64 or '')} "
            f"model_routing_mode={routing.model_routing_mode} "
            f"selected_model={routing.selected_model} "
            f"selected_model_reason={routing.selected_model_reason} "
            f"vision_used={str(routing.vision_used).lower()}",
            flush=True,
        )
    timer = startTimer("ocr")
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "ocr",
        "model": routing.selected_model,
        "mode": "ocr",
        "selectedPages": request.pageNumbers or [],
        "imagePageCount": len(request.pageNumbers or []),
        "detailMode": bool(request.detailMode),
        "payloadLength": len(request.pdfBase64 or ""),
        **_routing_log_fields(routing),
    })
    try:
        data = analyze_vision_document(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "ocr",
            "model": routing.selected_model,
            "mode": "ocr",
            "selectedPages": request.pageNumbers or [],
            "imagePageCount": len(request.pageNumbers or []),
            "latencyMs": endTimer(timer),
            "jsonValidation": "success",
            "parsing": "success",
            **_routing_log_fields(routing),
        })
        return {
            "success": True,
            "data": data,
        }
    except VisionDocumentError as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "ocr",
            "latencyMs": endTimer(timer),
            "jsonValidation": "failure",
        })
        raise HTTPException(
            status_code=exc.status_code,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logError("python_endpoint_failed", exc, {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "ocr",
            "latencyMs": endTimer(timer),
            "jsonValidation": "failure",
        })
        raise HTTPException(
            status_code=500,
            detail="Unable to analyze resource image with OCR",
        ) from exc
    finally:
        logArchitecture("request_temp_cleanup_done", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "ocr",
            "request_temp_cleanup_done": True,
            "context_chars_before": context_chars_before,
            "context_chars_after": 0,
        })
