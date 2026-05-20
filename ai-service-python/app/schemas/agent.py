from typing import Any

from pydantic import BaseModel, Field


class AvailableAction(BaseModel):
    name: str
    riskLevel: str | None = None
    requiredFields: list[str] = Field(default_factory=list)


class FileContextFile(BaseModel):
    originalName: str
    mimeType: str | None = None
    size: int | None = None
    storedPath: str | None = None
    extractedText: str | None = None
    extractionStatus: str | None = None


class FileContext(BaseModel):
    combinedText: str = ""
    files: list[FileContextFile] = Field(default_factory=list)
    hasUploadedFiles: bool = False


class ProfileContext(BaseModel):
    fullName: str | None = None
    email: str | None = None
    phoneNumber: str | None = None
    rib: str | None = None


class AgentAnalyzeRequest(BaseModel):
    message: str
    userRole: str
    availableActions: list[AvailableAction] = Field(default_factory=list)
    conversationHistory: list[dict[str, Any]] = Field(default_factory=list)
    fileContext: FileContext | None = None
    profileContext: ProfileContext | None = None


class AgentAnalyzeData(BaseModel):
    source: str
    language: str
    agentMode: str = "informational_answer"
    intent: str
    actionName: str | None
    confidence: float
    missingFields: list[str] = Field(default_factory=list)
    extractedFields: dict[str, Any] = Field(default_factory=dict)
    requiredTool: str = "none"
    toolInput: dict[str, Any] = Field(default_factory=dict)
    assistantMessage: str


class AgentAnalyzeResponse(BaseModel):
    success: bool
    data: AgentAnalyzeData
