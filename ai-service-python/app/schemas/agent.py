from typing import Any

from pydantic import BaseModel, Field


class AvailableAction(BaseModel):
    name: str
    riskLevel: str | None = None
    requiredFields: list[str] = Field(default_factory=list)


class AgentAnalyzeRequest(BaseModel):
    message: str
    userRole: str
    availableActions: list[AvailableAction] = Field(default_factory=list)
    conversationHistory: list[dict[str, Any]] = Field(default_factory=list)


class AgentAnalyzeData(BaseModel):
    source: str
    language: str
    intent: str
    actionName: str | None
    confidence: float
    missingFields: list[str] = Field(default_factory=list)
    extractedFields: dict[str, Any] = Field(default_factory=dict)
    assistantMessage: str


class AgentAnalyzeResponse(BaseModel):
    success: bool
    data: AgentAnalyzeData
