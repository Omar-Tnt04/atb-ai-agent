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
    systemInstruction: str | None = None
    generalFallback: dict[str, Any] | None = None
    generalNaturalChat: dict[str, Any] | None = None
    resourceResponseWriter: dict[str, Any] | None = None


class ModelRoutingContext(BaseModel):
    modelRoutingMode: str | None = None
    selectedModel: str | None = None
    selectedKeepAlive: str | None = None
    selectedModelReason: str | None = None
    visionUsed: bool | None = None


class AgentAnalyzeRequest(BaseModel):
    requestId: str | None = None
    threadId: str | None = None
    message: str
    userRole: str
    availableActions: list[AvailableAction] = Field(default_factory=list)
    conversationHistory: list[dict[str, Any]] = Field(default_factory=list)
    fileContext: FileContext | None = None
    resolvedResourceContext: ResolvedResourceContext | None = None
    profileContext: ProfileContext | None = None
    agentContext: AgentContext | None = None
    modelRouting: ModelRoutingContext | None = None


class VisionDocumentAnalyzeRequest(BaseModel):
    requestId: str | None = None
    threadId: str | None = None
    message: str
    userRole: str
    conversationHistory: list[dict[str, Any]] = Field(default_factory=list)
    profileContext: ProfileContext | None = None
    agentContext: AgentContext | None = None
    source: str = "backend_pdf"
    fileName: str | None = None
    mimeType: str | None = "application/pdf"
    pdfBase64: str
    resourceJson: dict[str, Any] | None = None
    maxPages: int | None = None
    pageNumbers: list[int] | None = None
    detailMode: bool | None = False
    modelRouting: ModelRoutingContext | None = None


class AgentAnalyzeData(BaseModel):
    source: str
    language: str
    agentMode: str = "informational_answer"
    intent: str
    actionName: str | None
    suggestedAction: str | None = None
    documentType: str | None = None
    documentTypeDetected: str | None = None
    confidence: float
    warnings: list[str] = Field(default_factory=list)
    markdown: str | None = None
    missingFields: list[str] = Field(default_factory=list)
    extractedFields: dict[str, Any] = Field(default_factory=dict)
    requiredTool: str = "none"
    toolInput: dict[str, Any] = Field(default_factory=dict)
    assistantMessage: str


class AgentAnalyzeResponse(BaseModel):
    success: bool
    data: AgentAnalyzeData


class AgentDecisionData(BaseModel):
    decision: str
    intent: str = "unknown"
    resourceQuery: str | None = None
    action: str | None = None
    fields: dict[str, Any] = Field(default_factory=dict)
    missingFields: list[str] = Field(default_factory=list)
    clarificationQuestion: str | None = None
    quickActions: list[dict[str, Any]] = Field(default_factory=list)


class AgentDecisionResponse(BaseModel):
    success: bool
    data: AgentDecisionData


class IntentPlannerData(BaseModel):
    mode: str
    needsResourceSearch: bool = False
    resourceSearchQuery: str | None = None
    needsActionFlow: bool = False
    needsDownload: bool = False
    actionType: str | None = None
    userGoal: str | None = None
    confidence: float = 0.0
    reason: str | None = None


class IntentPlannerResponse(BaseModel):
    success: bool
    data: IntentPlannerData
