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
    fileKind: str | None = None
    isVisualInput: bool | None = None
    isOcrDerived: bool | None = None
    isScannedOrImageBased: bool | None = None
    extractedText: str | None = None
    extractionStatus: str | None = None
    extractionError: str | None = None


class FileContext(BaseModel):
    combinedText: str = ""
    files: list[FileContextFile] = Field(default_factory=list)
    hasUploadedFiles: bool = False


class ResolvedResourceContext(BaseModel):
    resourceUrl: str | None = None
    resourceJson: dict[str, Any] | None = None
    fileUrl: str | None = None
    fileTextPreview: str = ""
    fileText: str = ""
    contentType: str | None = None
    extractionStatus: str | None = None
    extractionError: str | None = None


class ProfileContext(BaseModel):
    fullName: str | None = None
    email: str | None = None
    phoneNumber: str | None = None
    rib: str | None = None


class PendingAction(BaseModel):
    actionName: str | None = None
    missingFields: list[str] = Field(default_factory=list)
    collectedFields: dict[str, Any] = Field(default_factory=dict)


class AgentContext(BaseModel):
    extractedFields: dict[str, Any] = Field(default_factory=dict)
    suggestedAction: str | None = None
    pendingAction: PendingAction | None = None


class AgentAnalyzeRequest(BaseModel):
    message: str
    userRole: str
    availableActions: list[AvailableAction] = Field(default_factory=list)
    conversationHistory: list[dict[str, Any]] = Field(default_factory=list)
    fileContext: FileContext | None = None
    resolvedResourceContext: ResolvedResourceContext | None = None
    profileContext: ProfileContext | None = None
    agentContext: AgentContext | None = None


class AgentAnalyzeData(BaseModel):
    source: str
    language: str
    agentMode: str = "informational_answer"
    intent: str
    actionName: str | None
    documentTypeDetected: str | None = None
    confidence: float
    missingFields: list[str] = Field(default_factory=list)
    extractedFields: dict[str, Any] = Field(default_factory=dict)
    requiredTool: str = "none"
    toolInput: dict[str, Any] = Field(default_factory=dict)
    assistantMessage: str


class AgentAnalyzeResponse(BaseModel):
    success: bool
    data: AgentAnalyzeData
