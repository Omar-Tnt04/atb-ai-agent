from fastapi import FastAPI, HTTPException

from app.schemas.agent import AgentAnalyzeRequest, AgentAnalyzeResponse
from app.services.intent_service import analyze_message

app = FastAPI(
    title="ATB AI Banking Agent AI Service",
    version="0.1.0",
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
    try:
        return {
            "success": True,
            "data": analyze_message(request),
        }
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail="Unable to analyze message",
        ) from exc
