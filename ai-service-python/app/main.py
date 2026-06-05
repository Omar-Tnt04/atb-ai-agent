from fastapi import FastAPI, HTTPException

from app.config import settings
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


@app.on_event("startup")
def log_active_ai_model():
    print(
        "ATB AI service using Ollama model "
        f"{settings.OLLAMA_MODEL} at {settings.OLLAMA_BASE_URL} "
        f"keep_alive={settings.OLLAMA_KEEP_ALIVE} "
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
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "analyze",
        "model": settings.OLLAMA_MODEL,
        "mode": "text",
        "messagePreview": message_preview(request.message),
    })
    try:
        data = analyze_message(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "analyze",
            "model": settings.OLLAMA_MODEL,
            "mode": "text",
            "latencyMs": endTimer(timer),
            "jsonValidation": "success",
            "parsing": "success",
            "intent": data.get("intent"),
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


@app.post("/agent/decide", response_model=AgentDecisionResponse)
def decide_agent_message(request: AgentAnalyzeRequest):
    timer = startTimer("decide")
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "decide",
        "model": settings.OLLAMA_MODEL,
        "mode": "text",
        "messagePreview": message_preview(request.message),
    })
    try:
        data = decide_message(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "decide",
            "model": settings.OLLAMA_MODEL,
            "mode": "text",
            "latencyMs": endTimer(timer),
            "jsonValidation": "success",
            "parsing": "success",
            "decision": data.get("decision"),
            "intent": data.get("intent"),
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


@app.post("/agent/plan", response_model=IntentPlannerResponse)
def plan_agent_message(request: AgentAnalyzeRequest):
    timer = startTimer("planner")
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "plan",
        "model": settings.OLLAMA_MODEL,
        "mode": "text",
        "messagePreview": message_preview(request.message),
    })
    try:
        data = plan_intent(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "plan",
            "model": settings.OLLAMA_MODEL,
            "mode": "text",
            "latencyMs": endTimer(timer),
            "jsonValidation": "success",
            "parsing": "success",
            "plannerMode": data.get("mode"),
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


@app.post("/agent/analyze-vision-document", response_model=AgentAnalyzeResponse)
def analyze_agent_vision_document(request: VisionDocumentAnalyzeRequest):
    print(
        "[vision-pdf] endpoint_received "
        f"source={request.source} "
        f"mime_type={request.mimeType or 'unknown'} "
        f"pdf_base64_length={len(request.pdfBase64 or '')}",
        flush=True,
    )
    timer = startTimer("vision")
    logArchitecture("python_endpoint_called", {
        "requestId": request.requestId,
        "threadId": request.threadId,
        "endpoint": "vision",
        "model": settings.OLLAMA_MODEL,
        "mode": "vision",
        "selectedPages": request.pageNumbers or [],
        "imagePageCount": len(request.pageNumbers or []),
        "detailMode": bool(request.detailMode),
        "pdfBase64Length": len(request.pdfBase64 or ""),
    })
    try:
        data = analyze_vision_document(request)
        logArchitecture("python_endpoint_finished", {
            "requestId": request.requestId,
            "threadId": request.threadId,
            "endpoint": "vision",
            "model": settings.OLLAMA_MODEL,
            "mode": "vision",
            "selectedPages": request.pageNumbers or [],
            "imagePageCount": len(request.pageNumbers or []),
            "latencyMs": endTimer(timer),
            "jsonValidation": "success",
            "parsing": "success",
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
