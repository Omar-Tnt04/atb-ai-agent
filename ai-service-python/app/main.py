import json

from fastapi import FastAPI, HTTPException

from app.config import settings
from app.config.model_routing import select_model
from app.schemas.agent import (
    AgentAnalyzeRequest,
    AgentAnalyzeResponse,
    AgentDecisionResponse,
    IntentPlannerResponse,
    VisionDocumentAnalyzeRequest,
)
from app.services.decision_service import decide_message
from app.services.intent_planner_service import IntentPlannerError, plan_intent
from app.services.intent_service import analyze_message
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
    text_selection = select_model(requires_vision=False)
    vision_selection = select_model(requires_vision=True)
    print(
        "ATB AI service using model routing "
        f"mode={settings.MODEL_ROUTING_MODE} at {settings.OLLAMA_BASE_URL} "
        f"text_model={text_selection.selected_model} "
        f"text_keep_alive={text_selection.selected_keep_alive} "
        f"vision_model={vision_selection.selected_model} "
        f"vision_keep_alive={vision_selection.selected_keep_alive} "
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
        "messagePreview": message_preview(request.message),
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
            "plannerMode": data.get("mode"),
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


@app.post("/agent/analyze-vision-document", response_model=AgentAnalyzeResponse)
def analyze_agent_vision_document(request: VisionDocumentAnalyzeRequest):
    routing = select_model(requires_vision=True)
    context_chars_before = _request_context_chars(request, exclude={"pdfBase64"})
    print(
        "[vision-pdf] endpoint_received "
        f"source={request.source} "
        f"mime_type={request.mimeType or 'unknown'} "
        f"pdf_base64_length={len(request.pdfBase64 or '')} "
        f"model_routing_mode={routing.model_routing_mode} "
        f"selected_model={routing.selected_model} "
        f"selected_model_reason={routing.selected_model_reason} "
        f"vision_used={str(routing.vision_used).lower()}",
        flush=True,
    )
    timer = startTimer("vision")
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "vision",
        "model": routing.selected_model,
        "mode": "vision" if routing.vision_used else "text",
        "selectedPages": request.pageNumbers or [],
        "imagePageCount": len(request.pageNumbers or []),
        "detailMode": bool(request.detailMode),
        "pdfBase64Length": len(request.pdfBase64 or ""),
        **_routing_log_fields(routing),
    })
    try:
        data = analyze_vision_document(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "vision",
            "model": routing.selected_model,
            "mode": "vision" if routing.vision_used else "text",
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
            "endpoint": "vision",
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
            "endpoint": "vision",
            "latencyMs": endTimer(timer),
            "jsonValidation": "failure",
        })
        raise HTTPException(
            status_code=500,
            detail="Unable to analyze PDF visually",
        ) from exc
    finally:
        logArchitecture("request_temp_cleanup_done", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "vision",
            "request_temp_cleanup_done": True,
            "context_chars_before": context_chars_before,
            "context_chars_after": 0,
        })
