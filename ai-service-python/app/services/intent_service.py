import csv
import io
import json
import re

from app.schemas.agent import AgentAnalyzeRequest, AvailableAction
from app.config import settings
from app.services.field_extraction_service import PERIOD_PATTERN, extract_fields
from app.services.ollama_service import OllamaServiceError, analyze_with_ollama
from app.utils.language import detect_language


INTENT_KEYWORDS = {
    "check_balance": [
        "balance",
        "solde",
        "رصيد",
        "account amount",
        "how much",
    ],
    "view_transactions": [
        "transactions",
        "history",
        "statement activity",
        "mouvements",
        "historique",
        "عمليات",
    ],
    "generate_document": [
        "generate document",
        "download document",
        "create document",
        "request document",
        "download my statement",
        "generate statement",
        "request statement",
        "download statement",
        "generate rib",
        "download rib",
        "attestation",
        "releve",
        "relevé",
        "كشف",
    ],
    "create_complaint": [
        "complaint",
        "claim",
        "problem",
        "issue",
        "reclamation",
        "réclamation",
        "شكوى",
    ],
    "book_appointment": [
        "appointment",
        "meeting",
        "branch",
        "rendez-vous",
        "agence",
        "موعد",
    ],
    "pay_bill": [
        # Requires an explicit payment verb — "bill" alone is too broad and
        # would match queries like "Can you understand this bill?"
        "pay bill",
        "pay this bill",
        "pay my bill",
        "pay the bill",
        "settle this bill",
        "settle the bill",
        "settle bill",
        "proceed with payment",
        "execute payment",
        "pay invoice",
        "payer facture",
        "payer cette facture",
        "régler la facture",
        "facture",
        "steg",
        "sonede",
        "ooredoo",
        "فاتورة",
        "دفع",
    ],
    "make_transfer": [
        "transfer",
        "send money",
        "wire",
        "virement",
        "transferer",
        "transférer",
        "تحويل",
    ],
}

# File generation: user wants an exported/downloadable file
# Excludes banking documents (covered by INTENT_KEYWORDS["generate_document"])
FILE_GENERATION_KEYWORDS = [
    "generate a report",
    "generate report",
    "create a report",
    "export as csv",
    "export to csv",
    "save as csv",
    "export as json",
    "export to json",
    "export as txt",
    "save as txt",
    "make a summary file",
    "create a summary file",
    "give me a downloadable",
    "generate a downloadable",
    "download this as",
    "save this as",
    "export this as",
    "export this conversation",
    "export the conversation",
    "create a pdf report",
    "generate a pdf",
    "make a pdf",
    "generate a csv",
    "make a csv",
    "generate a json",
    "make a json file",
    "make a text file",
    "generate a text file",
    "export data as",
    "download as file",
]

FILE_ANALYSIS_KEYWORDS = [
    "understand",
    "can you understand",
    "read",
    "read this",
    "analyze",
    "analyse",
    "summarize",
    "summary",
    "explain",
    "extract information",
    "extract data",
    "what is in",
    "what does",
    "what's in",
    "whats in",
    "review this",
    "what is this",
    "what is this file",
    "tell me about this",
    "tell me about this file",
    "describe this",
    "describe the",
    "what do you see",
    "what can you see",
    "is there anything",
    "what information",
    "give me a summary",
    "break this down",
    "break down",
]

BILL_CONTEXT_KEYWORDS = [
    "bill",
    "facture",
    "invoice",
    "steg",
    "sonede",
    "ooredoo",
    "orange",
    "tunisie telecom",
]

# Banking document keywords that take priority over file generation
BANKING_DOCUMENT_KEYWORDS = [
    "generate document",
    "download document",
    "create document",
    "request document",
    "generate statement",
    "download statement",
    "generate rib",
    "download rib",
    "attestation",
    "releve",
    "relevé",
]

VALID_LANGUAGES = {"english", "french", "arabic", "unknown"}

VALID_INTENTS = {
    "file_analysis",
    "analyze_uploaded_file",
    "check_balance",
    "generate_document",
    "create_complaint",
    "check_complaint_status",
    "book_appointment",
    "list_appointment_slots",
    "pay_bill",
    "make_transfer",
    "informational_answer",
    "unknown",
}


# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------

def _has_file_text(request: AgentAnalyzeRequest) -> bool:
    """True if extracted text is available from uploaded files."""
    return bool(
        (request.fileContext and request.fileContext.combinedText.strip())
        or _has_resource_text(request)
    )


def _has_resource_context(request: AgentAnalyzeRequest) -> bool:
    return bool(request.resolvedResourceContext)


def _has_resource_text(request: AgentAnalyzeRequest) -> bool:
    resource = request.resolvedResourceContext
    return bool(
        resource
        and resource.extractionStatus == "extracted"
        and resource.fileText
        and resource.fileText.strip()
    )


def _has_document_context(request: AgentAnalyzeRequest) -> bool:
    return _has_uploaded_files(request) or _has_resource_context(request)


def _has_uploaded_files(request: AgentAnalyzeRequest) -> bool:
    """True if the user sent at least one file (even if text extraction failed).

    Checks the explicit hasUploadedFiles flag first (most reliable — set by Node.js
    before any file-list serialization can be lost), then falls back to files list length.
    """
    if not request.fileContext:
        return False
    if request.fileContext.hasUploadedFiles:
        return True
    return bool(request.fileContext.files and len(request.fileContext.files) > 0)


def _get_file_text(request: AgentAnalyzeRequest) -> str:
    parts: list[str] = []

    if request.fileContext and request.fileContext.combinedText.strip():
        parts.append(request.fileContext.combinedText.strip())

    if _has_resource_text(request):
        resource = request.resolvedResourceContext
        parts.append(resource.fileText.strip())

    return "\n\n---\n\n".join(part for part in parts if part)


def _get_profile_text(request: AgentAnalyzeRequest) -> str:
    profile = request.profileContext
    if not profile:
        return ""
    parts = []
    if profile.fullName:
        parts.append(f"Full name: {profile.fullName}")
    if profile.email:
        parts.append(f"Email: {profile.email}")
    if profile.phoneNumber:
        parts.append(f"Phone number: {profile.phoneNumber}")
    if profile.rib:
        parts.append(f"Tunisian bank account RIB: {profile.rib}")
    return "\n".join(parts)


def _get_agent_context_fields(request: AgentAnalyzeRequest) -> dict:
    if not request.agentContext:
        return {}
    return {
        key: value
        for key, value in (request.agentContext.extractedFields or {}).items()
        if not str(key).lower().startswith("_resource")
        and value is not None
        and not (isinstance(value, str) and value.strip() == "")
    }


def _is_visual_file(file) -> bool:
    name = (file.originalName or "").lower()
    mime = (file.mimeType or "").lower()
    return bool(
        file.isVisualInput
        or file.isScannedOrImageBased
        or mime.startswith("image/")
        or name.endswith((".png", ".jpg", ".jpeg", ".webp"))
    )


def _has_visual_or_ocr_file(request: AgentAnalyzeRequest) -> bool:
    if not request.fileContext:
        return False

    return any(
        _is_visual_file(file)
        or file.isOcrDerived
        or file.extractionStatus in {"ocr_extracted", "ocr_empty"}
        for file in request.fileContext.files
    )


def _has_ocr_extracted_file(request: AgentAnalyzeRequest) -> bool:
    if not request.fileContext:
        return False

    return any(
        file.isOcrDerived or file.extractionStatus == "ocr_extracted"
        for file in request.fileContext.files
    )


def _primary_extraction_status(request: AgentAnalyzeRequest) -> str | None:
    if not request.fileContext:
        return None

    statuses = [file.extractionStatus for file in request.fileContext.files if file.extractionStatus]
    if "ocr_extracted" in statuses:
        return "ocr_extracted"
    if "ocr_empty" in statuses:
        return "ocr_empty"
    return statuses[0] if statuses else None


def _attach_file_source_metadata(
    fields: dict,
    request: AgentAnalyzeRequest,
    document_type: str | None = None,
) -> dict:
    if not _has_uploaded_files(request):
        return fields

    status = _primary_extraction_status(request)
    is_visual = _has_visual_or_ocr_file(request)

    if not status and not is_visual:
        return fields

    return _clean_extracted_fields({
        **fields,
        "_sourceDocumentType": document_type,
        "_sourceExtractionStatus": status,
        "_sourceIsVisual": is_visual,
    })


def _has_visual_or_ocr_context(
    request: AgentAnalyzeRequest,
    fields: dict | None = None,
) -> bool:
    if _has_visual_or_ocr_file(request):
        return True

    fields = fields or _get_agent_context_fields(request)
    return bool(
        fields.get("_sourceIsVisual") is True
        or fields.get("_sourceExtractionStatus") in {"ocr_extracted", "ocr_empty"}
    )


def _infer_intent_from_context(request: AgentAnalyzeRequest) -> str | None:
    normalized_message = request.message.lower().strip(" .!?")
    follow_up_terms = {
        "pay it",
        "pay this",
        "do it",
        "continue",
        "proceed",
        "please proceed",
        "confirm",
        "generate it",
        "book it",
        "submit it",
    }

    if normalized_message not in follow_up_terms:
        return None

    suggested_action = request.agentContext.suggestedAction if request.agentContext else None
    if suggested_action:
        return suggested_action

    fields = _get_agent_context_fields(request)
    if fields.get("billReference") or fields.get("provider"):
        return "pay_bill"
    if fields.get("beneficiaryId"):
        return "make_transfer"
    if fields.get("documentType") or fields.get("period"):
        return "generate_document"
    if fields.get("category"):
        return "create_complaint"
    if fields.get("branch") or fields.get("date"):
        return "book_appointment"

    return None


def _contextual_fields_for_intent(intent: str, request: AgentAnalyzeRequest) -> dict:
    profile_text = _get_profile_text(request)
    file_text = _get_file_text(request)
    context_fields = _get_agent_context_fields(request)
    document_type = detect_document_type(request) if _has_document_context(request) else None

    merged_fields: dict = {}

    if intent == "pay_bill" and _has_visual_or_ocr_file(request):
        merged_fields.update(_resource_fields_for_intent(intent, request))
        if file_text and _document_type_supports_intent(document_type, intent):
            merged_fields.update(extract_fields(intent, file_text))
        merged_fields.update(extract_fields(intent, request.message))
        return _attach_resource_source_metadata(_attach_file_source_metadata(
            _clean_extracted_fields(merged_fields),
            request,
            document_type,
        ), request)

    if profile_text:
        merged_fields.update(extract_fields(intent, profile_text))
    if context_fields:
        merged_fields.update(context_fields)
    merged_fields.update(_resource_fields_for_intent(intent, request))
    if file_text and _document_type_supports_intent(document_type, intent):
        merged_fields.update(extract_fields(intent, file_text))
    merged_fields.update(extract_fields(intent, request.message))

    return _attach_resource_source_metadata(_attach_file_source_metadata(
        _clean_extracted_fields(merged_fields),
        request,
        document_type,
    ), request)


def _is_file_analysis_request(request: AgentAnalyzeRequest) -> bool:
    """
    True when the user uploaded a file AND is asking to understand/analyze it.

    Uses _has_uploaded_files (not _has_file_text) so that the guard works even
    when text extraction failed and combinedText is empty.  If we fell back to
    _has_file_text, a failed extraction would bypass this check and the
    message keywords ("bill", "invoice") would incorrectly trigger banking
    intent detection instead.
    """
    if not _has_uploaded_files(request):
        return False
    normalized_message = request.message.lower()
    return any(keyword in normalized_message for keyword in FILE_ANALYSIS_KEYWORDS)


def _is_resource_analysis_request(request: AgentAnalyzeRequest) -> bool:
    if not _has_resource_context(request):
        return False

    normalized_message = request.message.lower()
    explicit_action_patterns = [
        r"\bpay\s+(?:this\s+|the\s+|my\s+)?bill\b",
        r"\bsettle\s+(?:this\s+|the\s+|my\s+)?bill\b",
        r"\bmake\s+(?:a\s+)?transfer\b",
        r"\bprepare\s+(?:the\s+)?transfer\b",
        r"\btransfer\s+order\b",
        r"\bsend\s+money\b",
        r"\bbook\s+(?:a\s+|an\s+|the\s+)?appointment\b",
        r"\b(create|submit|file|raise|open)\s+(?:a\s+)?complaint\b",
        r"\b(generate|download|request)\s+(?:a\s+|the\s+)?document\b",
    ]

    return not any(
        re.search(pattern, normalized_message)
        for pattern in explicit_action_patterns
    )


def _is_file_generation_request(message: str) -> bool:
    """User wants a downloadable generated file (not a banking document)."""
    normalized = message.lower()
    # Banking document requests (generate_document intent) take precedence
    if any(kw in normalized for kw in BANKING_DOCUMENT_KEYWORDS):
        return False
    return any(kw in normalized for kw in FILE_GENERATION_KEYWORDS)


def _looks_like_bill(text: str) -> bool:
    normalized_text = text.lower()
    return any(keyword in normalized_text for keyword in BILL_CONTEXT_KEYWORDS)


def _detect_output_file_type(message: str) -> str:
    normalized = message.lower()
    if "csv" in normalized:
        return "csv"
    if "json" in normalized:
        return "json"
    if "pdf" in normalized:
        return "pdf"
    return "txt"


def _extract_file_title(message: str) -> str:
    normalized = message.lower()
    if "conversation" in normalized or "chat" in normalized:
        return "Conversation Summary"
    if "report" in normalized:
        return "Report"
    if "summary" in normalized:
        return "Summary"
    if "statement" in normalized:
        return "Statement"
    return "Generated File"


# ---------------------------------------------------------------------------
# Uploaded document classification
# ---------------------------------------------------------------------------

DOCUMENT_TYPE_VALUES = {
    "bill",
    "account_statement",
    "transactions_csv",
    "complaint_document",
    "appointment_request",
    "profile_json",
    "generic_document",
    "scanned_or_image_document",
}

TRANSACTION_COLUMN_ALIASES = {
    "date": {"date", "transaction_date", "operation_date"},
    "label": {"label", "description", "libelle", "wording", "memo"},
    "amount": {"amount", "montant", "value"},
    "type": {"type", "direction", "debit_credit", "movement"},
}


def _strip_file_metadata(file_text: str) -> str:
    lines = []
    for line in file_text.splitlines():
        stripped = line.strip()
        if re.match(r"^(file|mime)\s*:", stripped, re.IGNORECASE):
            continue
        if stripped == "---":
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def _normalized_column_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")


def _matches_column(columns: set[str], aliases: set[str]) -> bool:
    return any(column in aliases for column in columns)


def _csv_rows_from_text(file_text: str) -> list[dict[str, str]]:
    csv_text = _strip_file_metadata(file_text)
    if not csv_text:
        return []

    try:
        rows = list(csv.DictReader(io.StringIO(csv_text)))
    except csv.Error:
        return []

    return rows if rows and any(rows[0].keys()) else []


def _csv_has_transaction_columns(rows: list[dict[str, str]]) -> bool:
    if not rows:
        return False

    columns = {_normalized_column_name(column) for column in rows[0].keys() if column}
    return all(
        _matches_column(columns, TRANSACTION_COLUMN_ALIASES[column_key])
        for column_key in ("date", "label", "amount", "type")
    )


def _has_file_kind(request: AgentAnalyzeRequest, kind: str) -> bool:
    if request.resolvedResourceContext:
        resource = request.resolvedResourceContext
        file_url = (resource.fileUrl or "").lower()
        content_type = (resource.contentType or "").lower()
        if kind == "csv" and (file_url.endswith(".csv") or "csv" in content_type):
            return True
        if kind == "json" and (file_url.endswith(".json") or "json" in content_type):
            return True
        if kind == "pdf" and (file_url.endswith(".pdf") or content_type == "application/pdf"):
            return True

    if not request.fileContext:
        return False

    for file in request.fileContext.files:
        name = (file.originalName or "").lower()
        mime = (file.mimeType or "").lower()
        if kind == "csv" and (name.endswith(".csv") or "csv" in mime):
            return True
        if kind == "json" and (name.endswith(".json") or "json" in mime):
            return True
        if kind == "image" and mime.startswith("image/"):
            return True
        if kind == "pdf" and (name.endswith(".pdf") or mime == "application/pdf"):
            return True
    return False


def _has_unreadable_visual_file(request: AgentAnalyzeRequest, file_text: str) -> bool:
    if file_text.strip():
        return False
    if _has_resource_context(request):
        resource = request.resolvedResourceContext
        return bool(
            resource
            and resource.fileUrl
            and (
                (resource.fileUrl or "").lower().endswith(".pdf")
                or (resource.contentType or "").lower() == "application/pdf"
            )
            and resource.extractionStatus != "extracted"
        )
    if not _has_uploaded_files(request):
        return False

    files = request.fileContext.files if request.fileContext else []
    return any(
        (file.extractionStatus in {"metadata_only", "empty_text", "ocr_empty", "failed"})
        or (file.mimeType or "").lower().startswith("image/")
        or (file.originalName or "").lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".pdf"))
        for file in files
    )


def _is_profile_json_document(text: str) -> bool:
    clean_text = _strip_file_metadata(text)
    try:
        parsed = json.loads(clean_text)
    except Exception:
        return False

    if not isinstance(parsed, dict):
        return False

    keys = {_normalized_column_name(key) for key in parsed.keys()}
    profile_keys = {"fullname", "full_name", "email", "phonenumber", "phone_number", "rib"}
    return bool(keys & profile_keys)


def _has_transactions_table(text: str) -> bool:
    clean_text = _strip_file_metadata(text)
    normalized = clean_text.lower()
    if re.search(
        r"\bdate\b.{0,40}\b(label|description|libelle)\b.{0,40}\bamount\b.{0,40}\b(type|debit|credit)\b",
        normalized,
        re.DOTALL,
    ):
        return True

    table_headers = [
        line for line in clean_text.splitlines()
        if "date" in line.lower() and "amount" in line.lower()
    ]
    return any("|" in line or "," in line or "\t" in line for line in table_headers)


def _is_account_statement_document(text: str) -> bool:
    normalized = text.lower()
    strong_markers = [
        "account statement",
        "statement period",
        "opening balance",
        "closing balance",
    ]
    if any(marker in normalized for marker in strong_markers):
        return True

    balance_markers = ["opening balance", "closing balance", "solde initial", "solde final"]
    account_markers = ["account", "iban", "rib", "current account", "savings account"]
    return (
        any(marker in normalized for marker in balance_markers)
        and any(marker in normalized for marker in account_markers)
        and _has_transactions_table(text)
    )


def _is_complaint_document(text: str) -> bool:
    normalized = text.lower()
    return any(
        marker in normalized
        for marker in [
            "complaint document",
            "complaint category",
            "problem description",
            "failed transfer",
            "transfer failed",
            "transaction failed",
            "failed transaction",
            "amount deducted",
            "amount was deducted",
            "deducted from my account",
            "claim category",
            "reclamation",
        ]
    )


def _is_appointment_request_document(text: str) -> bool:
    normalized = text.lower()
    has_appointment = any(
        marker in normalized for marker in ["appointment", "rendez-vous", "meeting request"]
    )
    has_slot = "branch" in normalized and (
        bool(re.search(r"\b\d{4}-\d{2}-\d{2}\b", text))
        or bool(re.search(r"\b\d{1,2}:\d{2}\b", text))
        or "time" in normalized
    )
    return has_appointment and has_slot


def _is_bill_document(text: str) -> bool:
    bill_fields = extract_fields("pay_bill", text)
    provider = bill_fields.get("provider")
    bill_reference = bill_fields.get("billReference")
    amount = bill_fields.get("amount")
    due_date = bill_fields.get("dueDate")
    normalized = text.lower()
    has_bill_label = any(label in normalized for label in ["bill", "invoice", "facture", "due date"])

    return bool(provider and bill_reference and amount is not None and due_date and has_bill_label)


def detect_document_type(request: AgentAnalyzeRequest) -> str | None:
    if not _has_document_context(request):
        return None

    file_text = _get_file_text(request)

    if _has_unreadable_visual_file(request, file_text):
        return "scanned_or_image_document"

    if not file_text:
        return "generic_document"

    rows = _csv_rows_from_text(file_text)
    if _has_file_kind(request, "csv") and _csv_has_transaction_columns(rows):
        return "transactions_csv"

    if _is_profile_json_document(file_text):
        return "profile_json"

    # Document-level statement signals must win over biller names inside rows.
    if _is_account_statement_document(file_text):
        return "account_statement"

    if _is_complaint_document(file_text):
        return "complaint_document"

    if _is_appointment_request_document(file_text):
        return "appointment_request"

    if _is_bill_document(file_text):
        return "bill"

    return "generic_document"


def _document_type_supports_intent(document_type: str | None, intent: str) -> bool:
    if not document_type:
        return True

    supported = {
        "bill": {"pay_bill"},
        "account_statement": {"generate_document", "check_balance"},
        "transactions_csv": set(),
        "complaint_document": {"create_complaint"},
        "appointment_request": {"book_appointment", "list_appointment_slots"},
        "profile_json": set(),
        "generic_document": {
            "check_balance",
            "pay_bill",
            "make_transfer",
            "generate_document",
            "create_complaint",
            "book_appointment",
            "check_complaint_status",
        },
        "scanned_or_image_document": set(),
    }

    return intent in supported.get(document_type, set())


def _infer_intent_from_document_request(
    message: str,
    document_type: str | None,
) -> tuple[str, float] | None:
    normalized = message.lower().strip(" .!?")

    # When a bill is attached, both explicit pay verbs and phrases that point the
    # assistant at the file ("the details are in the file", "the bill I provided")
    # mean: pay it using the uploaded bill. Pure "review/summarize" wording is
    # handled earlier as file analysis, so it never reaches here.
    if document_type == "bill" and re.search(
        r"\b(pay|settle|continue|proceed|confirm|go ahead|do it|pay it|pay this|"
        r"provided|the details|find the details|use the file|use the details|"
        r"in the file|from the file|in the document|attached bill|uploaded bill)\b",
        normalized,
    ):
        return "pay_bill", 0.9

    if document_type == "complaint_document" and re.search(r"\b(create|submit|file|raise|open|send|do it|submit it)\b", normalized):
        return "create_complaint", 0.88

    if document_type == "appointment_request" and re.search(r"\b(book|schedule|confirm|do it|book it)\b", normalized):
        return "book_appointment", 0.88

    return None


# ---------------------------------------------------------------------------
# Intent / action helpers
# ---------------------------------------------------------------------------

def _has_any(text: str, patterns: list[str]) -> bool:
    return any(pattern in text for pattern in patterns)


def _matches_any(text: str, patterns: list[str]) -> bool:
    import re

    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


def detect_intent(message: str) -> tuple[str, float]:
    normalized_message = message.lower()

    if _matches_any(normalized_message, [r"\bcmp(?:-demo)?-\d{4}-\d{3,6}\b"]):
        return "check_complaint_status", 0.92

    if _has_any(normalized_message, ["complaint status", "claim status", "track complaint"]):
        return "check_complaint_status", 0.84

    if _has_any(normalized_message, ["available slots", "appointment slots", "show slots", "available appointments"]):
        return "list_appointment_slots", 0.86

    failed_transfer = _matches_any(
        normalized_message,
        [
            r"\bfailed\s+transfer\b",
            r"\btransfer\s+failed\b",
            r"\bfailed\s+transaction\b",
            r"\btransfer\s+issue\b",
            r"\btransfer\b.{0,80}\bfailed\b",
            r"\bfailed\b.{0,80}\btransfer\b",
            r"\bcharged\b.*\btransfer\b",
            r"\btransfer\b.*\bcharged\b",
        ],
    )

    complaint_language = _has_any(
        normalized_message,
        [
            "complaint",
            "complain",
            "claim",
            "reclamation",
            "réclamation",
            "look into",
            "investigate",
            "reviewed",
            "bank to look",
        ],
    )

    if failed_transfer and complaint_language:
        return "create_complaint", 0.94
    if failed_transfer:
        return "create_complaint", 0.82
    if complaint_language or _has_any(normalized_message, ["card issue", "account access issue", "payment issue"]):
        return "create_complaint", 0.86

    if _matches_any(
        normalized_message,
        [
            r"\bpay\b.*\b(bill|invoice|facture|steg|sonede|ooredoo|telecom|orange)\b",
            r"\b(bill|invoice|facture)\b.*\bpay\b",
            r"\bsettle\b.*\b(bill|invoice|facture)\b",
            r"\b(?:steg|sonede|ooredoo|telecom|orange)-\d{4}-\d{3}\b",
        ],
    ):
        return "pay_bill", 0.9

    if _matches_any(
        normalized_message,
        [
            r"\b(send|transfer|wire)\b.*\b(money|dinars?|tnd|dt|ben_\d+)\b",
            r"\bneed\s+to\s+send\b",
            r"\bmake\s+a\s+transfer\b",
        ],
    ):
        return "make_transfer", 0.88

    if _matches_any(
        normalized_message,
        [
            r"\b(statement|rib|certificate|attestation|document)\b",
            r"\bcopy\s+of\s+my\s+account\s+statement\b",
        ],
    ) and _has_any(
        normalized_message,
        ["need", "get", "copy", "generate", "download", "request", "create", "send me"],
    ):
        return "generate_document", 0.88

    if _has_any(normalized_message, ["balance", "solde", "how much"]) and "bill" not in normalized_message:
        return "check_balance", 0.86

    if _has_any(
        normalized_message,
        ["appointment", "rendez-vous", "visit", "branch", "agence", "meeting"],
    ):
        return "book_appointment", 0.82

    for intent, keywords in INTENT_KEYWORDS.items():
        if any(keyword in normalized_message for keyword in keywords):
            return intent, 0.72

    if _has_any(normalized_message, ["help", "what can you do", "assist me"]):
        return "informational_answer", 0.65

    return "unknown", 0.3


def find_available_action(
    intent: str,
    available_actions: list[AvailableAction],
) -> AvailableAction | None:
    return next(
        (action for action in available_actions if action.name == intent),
        None,
    )


def calculate_missing_fields(
    action: AvailableAction,
    extracted_fields: dict,
) -> list[str]:
    def is_missing(field: str) -> bool:
        if action.name == "pay_bill" and field == "sourceAccountId":
            value = extracted_fields.get("sourceAccountId") or extracted_fields.get("accountId")
            return value is None or (isinstance(value, str) and value.strip() == "")

        value = extracted_fields.get(field)
        return value is None or (isinstance(value, str) and value.strip() == "")

    required_fields = action.requiredFields
    if action.name == "pay_bill":
        required_fields = list(dict.fromkeys([
            *action.requiredFields,
            "provider",
            "billReference",
            "amount",
            "sourceAccountId",
        ]))

    missing_fields = [
        field
        for field in required_fields
        if is_missing(field)
    ]

    if action.name == "create_complaint":
        if "category" in missing_fields:
            return ["category"]
        if "description" in missing_fields:
            return ["description"]
        return []

    return missing_fields


# ---------------------------------------------------------------------------
# Message builders
# ---------------------------------------------------------------------------

def _format_extracted_value(value) -> str:
    if value is None or value == "":
        return "not found"
    return str(value)


FIELD_LABELS = {
    "accountId": "Account",
    "amount": "Amount",
    "beneficiaryId": "Beneficiary",
    "billReference": "Bill reference",
    "branch": "Branch name",
    "category": "Complaint category",
    "date": "Preferred date",
    "description": "Description",
    "documentType": "Document type",
    "period": "Period",
    "currency": "Currency",
    "reference": "Complaint reference",
    "sourceAccountId": "Source account",
    "time": "Preferred time slot",
}


def _format_field_label(field: str) -> str:
    return FIELD_LABELS.get(field, field)


def _format_amount(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and not value.is_integer():
        return f"{value:.3f} TND"
    return f"{int(value) if isinstance(value, float) else value} TND"


def _file_types(request: AgentAnalyzeRequest) -> set[str]:
    types: set[str] = set()

    if request.resolvedResourceContext:
        resource = request.resolvedResourceContext
        file_url = (resource.fileUrl or "").lower()
        content_type = (resource.contentType or "").lower()
        if file_url.endswith(".pdf") or content_type == "application/pdf":
            types.add("pdf")
        if file_url.endswith(".csv") or "csv" in content_type:
            types.add("csv")

    if not request.fileContext:
        return types

    for file in request.fileContext.files:
        name = (file.originalName or "").lower()
        mime = (file.mimeType or "").lower()
        if name.endswith(".csv") or "csv" in mime:
            types.add("csv")
        if name.endswith(".pdf") or mime == "application/pdf":
            types.add("pdf")
        if mime.startswith("image/"):
            types.add("image")
    return types


def _build_unreadable_file_message(request: AgentAnalyzeRequest, file_names: str) -> str:
    if request.resolvedResourceContext and not _has_uploaded_files(request):
        resource = request.resolvedResourceContext
        if resource.extractionStatus != "extracted":
            return (
                "I found the resource, but I could not extract readable text "
                "from the linked file."
            )

    files = request.fileContext.files if request.fileContext else []
    has_pdf = any(
        (file.mimeType or "").lower() == "application/pdf"
        or (file.originalName or "").lower().endswith(".pdf")
        for file in files
    )
    has_image = any(
        (file.mimeType or "").lower().startswith("image/")
        or file.extractionStatus in {"metadata_only", "ocr_empty"}
        for file in files
    )

    if has_pdf:
        return "I received the image, but I could not read enough text from it."

    if has_image:
        return "I received the image, but I could not read enough text from it."

    return (
        f"I received {file_names}, but I could not extract readable text from it. "
        "Please provide the key details manually."
    )


# Natural-language hints so the assistant asks like ChatGPT instead of listing
# robotic field labels. Each entry is (phrase, example) where example may be None.
FIELD_HINTS = {
    "accountId": ("the account ID", "acc_001"),
    "sourceAccountId": ("the account to use", "acc_001"),
    "billReference": ("the bill reference", "STEG-2026-001"),
    "amount": ("the amount", "300"),
    "beneficiaryId": ("the beneficiary", "ben_001"),
    "branch": ("the branch", "Tunis Centre"),
    "date": ("the date", "2026-05-21"),
    "time": ("a time", "10:00"),
    "documentType": ("the document type", "statement"),
    "period": ("the period", "April 2026"),
    "category": ("the complaint category", "failed transfer"),
    "description": ("a short description of the issue", None),
    "reference": ("the complaint reference", "CMP-DEMO-2026-000001"),
}


def _describe_missing_field(field: str) -> str:
    phrase, example = FIELD_HINTS.get(
        field, (_format_field_label(field).lower(), None)
    )
    if example:
        return f"{phrase} (for example `{example}`)"
    return phrase


def _build_missing_fields_message(
    intro: str,
    missing_fields: list[str],
) -> str:
    displayed_fields = missing_fields[:2]

    if len(displayed_fields) == 1:
        return f"{intro} I still need {_describe_missing_field(displayed_fields[0])}."

    parts = " and ".join(_describe_missing_field(field) for field in displayed_fields)
    return f"{intro} I still need {parts}."


def _build_ocr_pay_bill_missing_fields_message(
    missing_fields: list[str],
    extracted_fields: dict,
) -> str:
    only_source_account_missing = (
        missing_fields == ["sourceAccountId"]
        and extracted_fields.get("provider")
        and extracted_fields.get("billReference")
        and extracted_fields.get("amount") is not None
    )

    if only_source_account_missing:
        return "I can read the bill, but the source account is unclear. Which account should I use?"

    labels = [
        "source account" if field == "sourceAccountId" else _format_field_label(field).lower()
        for field in missing_fields[:3]
    ]
    if len(labels) == 1:
        field_text = labels[0]
    else:
        field_text = f"{', '.join(labels[:-1])} and {labels[-1]}"
    verb = "is" if len(labels) == 1 else "are"

    return (
        f"I can read parts of the scanned bill, but the {field_text} {verb} "
        f"unclear. Please provide {field_text} before I prepare the payment."
    )


def _build_action_message_for_context(
    request: AgentAnalyzeRequest,
    intent: str,
    action: AvailableAction | None,
    missing_fields: list[str],
    extracted_fields: dict,
) -> str:
    if (
        intent == "pay_bill"
        and missing_fields
        and _has_visual_or_ocr_context(request, extracted_fields)
    ):
        return _build_ocr_pay_bill_missing_fields_message(
            missing_fields,
            extracted_fields,
        )

    return build_assistant_message(intent, action, missing_fields)


def _build_legacy_file_summary_message(
    request: AgentAnalyzeRequest,
    extracted_fields: dict,
) -> str:
    file_text = _get_file_text(request)
    files = request.fileContext.files if request.fileContext else []
    file_names = ", ".join(file.originalName for file in files) or "the uploaded file"

    # Text extraction failed — tell the user clearly
    if not file_text:
        return _build_unreadable_file_message(request, file_names)

    file_types = _file_types(request)

    if _looks_like_bill(file_text):
        provider = extracted_fields.get("provider")
        bill_ref = extracted_fields.get("billReference")
        amount = extracted_fields.get("amount")
        account = extracted_fields.get("sourceAccountId")
        due_date = extracted_fields.get("dueDate")

        lines = []
        lines.append(
            f"**Bill summary**\n\nI found a {provider} bill."
            if provider
            else f"**Bill summary**\n\nI found a bill in {file_names}."
        )

        if bill_ref:
            lines.append(f"- **Bill reference:** {bill_ref}")

        if amount is not None:
            lines.append(f"- **Amount:** {_format_amount(amount)}")

        if due_date:
            lines.append(f"- **Due date:** {due_date}")

        if account:
            lines.append(f"- **Source account:** {account}")

        lines.append("\nI can help prepare the payment if you ask me to pay it.")
        return "\n".join(lines)

    if "csv" in file_types:
        csv_summary = _summarize_csv_text(file_text)
        if csv_summary:
            return "**CSV summary**\n\n" + "\n".join(csv_summary)

    statement_summary = _extract_statement_summary(file_text, extracted_fields)
    if statement_summary:
        return "\n".join(statement_summary)

    document_type = extracted_fields.get("documentType")
    period = extracted_fields.get("period")
    if document_type or period:
        lines = ["**Document summary**", f"- File: {file_names}"]
        if document_type:
            lines.append(f"- Document type: {document_type}")
        if period:
            lines.append(f"- Period: {period}")
        preview = " ".join(file_text.split())
        if len(preview) > 260:
            preview = f"{preview[:260]}..."
        lines.append(f"- Content preview: {preview}")
        return "\n".join(lines)

    preview = " ".join(file_text.split())
    if len(preview) > 420:
        preview = f"{preview[:420]}..."

    return (
        f"**File summary**\n\n"
        f"I read {file_names}. Here is a concise summary of the readable content:\n\n"
        f"- {preview}"
    )


def _parse_money_value(value) -> float | None:
    if value is None:
        return None

    text = str(value).strip()
    if not text:
        return None

    text = re.sub(r"\b(TND|DT|dinars?)\b", "", text, flags=re.IGNORECASE)
    text = text.replace(" ", "")
    if "," in text and "." in text:
        text = text.replace(",", "")
    else:
        text = text.replace(",", ".")

    match = re.search(r"-?\d+(?:\.\d+)?", text)
    if not match:
        return None

    try:
        return float(match.group(0))
    except ValueError:
        return None


def _format_money(value, currency: str = "TND") -> str:
    amount = _parse_money_value(value)
    if amount is None:
        return "not found"
    return f"{amount:.3f} {currency or 'TND'}"


def _format_signed_money(value, currency: str = "TND") -> str:
    amount = _parse_money_value(value)
    if amount is None:
        return "not found"
    sign = "+" if amount > 0 else ""
    return f"{sign}{amount:.3f} {currency or 'TND'}"


def _markdown_table(rows: list[tuple[str, object]]) -> str:
    usable_rows = [
        (label, value)
        for label, value in rows
        if value is not None and str(value).strip() != ""
    ]
    if not usable_rows:
        return ""
    return "\n".join([
        "| Field | Value |",
        "|---|---|",
        *[f"| {label} | {value} |" for label, value in usable_rows],
    ])


def _resource_json(request: AgentAnalyzeRequest) -> dict:
    resource = request.resolvedResourceContext
    return resource.resourceJson if resource and isinstance(resource.resourceJson, dict) else {}


def _resource_type(request: AgentAnalyzeRequest) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(_resource_json(request).get("resourceType") or "").lower()).strip("_")


BILL_RESOURCE_TYPES = {
    "bill",
    "bill_notice",
    "bill_payment",
    "bill_payment_notice",
    "bill_resource",
    "bill_invoice",
    "utility_bill",
    "utility_invoice",
    "invoice",
    "invoice_notice",
    "payment_notice",
    "payment_resource",
}


DIRECT_FACTUAL_RESOURCE_PATTERNS = [
    r"^\s*what\s+(?:is|was)\b",
    r"^\s*when\s+is\b",
    r"^\s*how\s+much\b",
    r"^\s*do\s+i\s+have\b",
    r"\bstatus\s+of\b",
    r"\bdue\b",
]

DOCUMENT_ORIENTED_TERMS = {
    "download",
    "get",
    "show",
    "open",
    "view",
    "summarize",
    "summary",
    "statement",
    "certificate",
    "document",
    "report",
    "pdf",
}

DOWNLOAD_ELIGIBLE_RESOURCE_TYPES = {
    "account_statement",
    "rib_certificate",
    "account_certificate",
    "card_dispute_report",
    "card_dispute",
    "transfer_order",
}

DOWNLOAD_EXCLUDED_RESOURCE_TYPES = {
    "loan_schedule",
    "fees_notice",
    "appointment_confirmation",
    "kyc_summary",
}


def should_show_download_pdf(user_message: str, resource_type: str) -> bool:
    normalized_message = user_message.lower()
    normalized_resource_type = re.sub(
        r"[^a-z0-9]+",
        "_",
        str(resource_type or "").lower(),
    ).strip("_")

    if any(re.search(pattern, normalized_message) for pattern in DIRECT_FACTUAL_RESOURCE_PATTERNS):
        return False

    if normalized_resource_type in DOWNLOAD_EXCLUDED_RESOURCE_TYPES:
        return False

    is_document_oriented = any(term in normalized_message for term in DOCUMENT_ORIENTED_TERMS)
    if not is_document_oriented:
        return False

    if normalized_resource_type in DOWNLOAD_ELIGIBLE_RESOURCE_TYPES:
        return True

    return any(term in normalized_message for term in {"download", "open", "pdf", "document"})


def _find_resource_value(data, keys: set[str]):
    if isinstance(data, dict):
        normalized_map = {str(key).lower(): value for key, value in data.items()}
        for key in keys:
            value = normalized_map.get(key.lower())
            if value not in (None, ""):
                return value
        for value in data.values():
            nested = _find_resource_value(value, keys)
            if nested not in (None, ""):
                return nested
    if isinstance(data, list):
        for item in data:
            nested = _find_resource_value(item, keys)
            if nested not in (None, ""):
                return nested
    return None


def _resource_fields_for_intent(intent: str, request: AgentAnalyzeRequest) -> dict:
    if intent != "pay_bill" or not request.resolvedResourceContext:
        return {}

    resource_json = _resource_json(request)
    resource_type = _resource_type(request)
    if resource_type not in BILL_RESOURCE_TYPES:
        return {}

    fields = {
        "provider": _find_resource_value(resource_json, {"provider", "biller", "merchant"}),
        "billReference": _find_resource_value(
            resource_json,
            {"billReference", "billRef", "invoiceReference", "reference"},
        ),
        "amount": _find_resource_value(
            resource_json,
            {"amount", "totalAmount", "total", "amountDue"},
        ),
        "currency": _find_resource_value(resource_json, {"currency"}),
        "dueDate": _find_resource_value(
            resource_json,
            {"dueDate", "paymentDueDate", "deadline"},
        ),
        "sourceAccountId": _find_resource_value(
            resource_json,
            {"sourceAccountId", "accountId", "debitAccountId"},
        ),
    }
    return _clean_extracted_fields(fields)


def _resource_quick_actions(request: AgentAnalyzeRequest) -> list[dict]:
    resource = request.resolvedResourceContext
    resource_json = _resource_json(request)
    resource_type = _resource_type(request)
    actions: list[dict] = []

    if resource and resource.fileUrl and should_show_download_pdf(request.message, resource_type):
        actions.append({
            "label": "Download PDF",
            "action": "open_url",
            "url": resource.fileUrl,
        })

    if resource_type == "transfer_order":
        actions.append({
            "label": "Prepare transfer",
            "action": "continue",
            "prompt": "Prepare transfer",
        })
    elif resource_type == "appointment_confirmation":
        actions.append({
            "label": "Book appointment",
            "action": "prompt",
            "prompt": "Book appointment",
        })

    return actions[:3]


def _resource_tool_input(request: AgentAnalyzeRequest) -> dict:
    if not request.resolvedResourceContext:
        return {}
    actions = _resource_quick_actions(request)
    return {"quickActions": actions} if actions else {}


def _attach_resource_source_metadata(fields: dict, request: AgentAnalyzeRequest) -> dict:
    resource = request.resolvedResourceContext
    if not resource:
        return fields
    return _clean_extracted_fields(fields)


def _extract_labeled_value(text: str, labels: list[str]) -> str | None:
    for label in labels:
        pattern = rf"^\s*{re.escape(label)}(?:\s*[:=-]\s*|\s+)(.+?)\s*$"
        match = re.search(pattern, text, re.IGNORECASE | re.MULTILINE)
        if match:
            return match.group(1).strip()
    return None


def _mask_account(value: str | None) -> str:
    if not value:
        return "not found"

    text = str(value).strip()
    digits = re.sub(r"\D", "", text)
    if len(digits) >= 8:
        return f"********{digits[-4:]}"
    return text


def _normalize_statement_account_id(value: str) -> str:
    match = re.search(r"acc[\s_-]*(\d+)", value, re.IGNORECASE)
    if not match:
        return value
    return f"acc_{match.group(1)}"


def _extract_statement_period(text: str, fields: dict) -> str:
    labeled_period = _extract_labeled_value(text, ["Statement period", "Period"])
    if labeled_period:
        return labeled_period

    if fields.get("period"):
        return str(fields["period"])

    period_match = PERIOD_PATTERN.search(text)
    if period_match:
        return period_match.group(0)

    range_match = re.search(
        r"\b(?:from|du)\s+(\d{4}-\d{2}-\d{2})\s+(?:to|au)\s+(\d{4}-\d{2}-\d{2})\b",
        text,
        re.IGNORECASE,
    )
    if range_match:
        return f"{range_match.group(1)} to {range_match.group(2)}"

    return "not found"


def _extract_statement_account(text: str, fields: dict) -> str:
    account = (
        _extract_labeled_value(text, ["Account", "Account number", "Account ID"])
        or fields.get("accountId")
    )
    if account and re.search(r"\bacc[\s_-]*\d+\b", str(account), re.IGNORECASE):
        return _normalize_statement_account_id(str(account))
    if not account:
        account_match = re.search(r"\b\d{10,24}\b", text)
        account = account_match.group(0) if account_match else None
    return _mask_account(account)


def _extract_statement_account_type(text: str) -> str:
    account_type = _extract_labeled_value(text, ["Type", "Account type"])
    if account_type:
        return account_type

    normalized = text.lower()
    if "current account" in normalized:
        return "Current Account"
    if "savings account" in normalized or "saving account" in normalized:
        return "Savings Account"
    return "not found"


def _extract_currency(text: str, fields: dict) -> str:
    if fields.get("currency"):
        return str(fields["currency"])
    if re.search(r"\b(TND|DT)\b", text, re.IGNORECASE):
        return "TND"
    return "TND"


def _extract_statement_balance(text: str, label: str) -> float | None:
    match = re.search(
        rf"\b{label}\s*[:=-]?\s*(-?\d+(?:[.,]\d+)?)\s*(?:TND|DT|dinars?)?",
        text,
        re.IGNORECASE,
    )
    return _parse_money_value(match.group(1)) if match else None


def _split_table_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _extract_transaction_rows(text: str, limit: int = 8) -> list[dict[str, str]]:
    clean_text = _strip_file_metadata(text)
    rows: list[dict[str, str]] = []

    lines = [line for line in clean_text.splitlines() if line.strip()]
    for index, line in enumerate(lines):
        if "|" not in line:
            continue
        headers = [_normalized_column_name(cell) for cell in _split_table_cells(line)]
        if not ("date" in headers and "amount" in headers):
            continue
        for row_line in lines[index + 2:]:
            if "|" not in row_line:
                break
            cells = _split_table_cells(row_line)
            if len(cells) < len(headers):
                continue
            row = dict(zip(headers, cells))
            rows.append({
                "date": row.get("date", ""),
                "label": row.get("label") or row.get("description") or row.get("libelle") or "",
                "amount": row.get("amount", ""),
                "type": row.get("type") or row.get("movement") or row.get("direction") or "",
            })
            if len(rows) >= limit:
                return rows

    for line in lines:
        match = re.match(
            r"^\s*(\d{4}-\d{2}-\d{2})\s+(.+?)\s+([+-]?\d+(?:[.,]\d+)?)\s*(?:TND|DT|dinars?)?\s+(debit|credit)\s*$",
            line,
            re.IGNORECASE,
        )
        if not match:
            continue
        rows.append({
            "date": match.group(1),
            "label": match.group(2).strip(),
            "amount": match.group(3).replace(",", "."),
            "type": match.group(4).title(),
        })
        if len(rows) >= limit:
            break

    return rows


def _build_account_statement_summary(file_text: str, fields: dict) -> str:
    currency = _extract_currency(file_text, fields)
    opening_balance = _extract_statement_balance(file_text, "opening balance")
    closing_balance = _extract_statement_balance(file_text, "closing balance")
    net_change = (
        closing_balance - opening_balance
        if opening_balance is not None and closing_balance is not None
        else None
    )
    transactions = _extract_transaction_rows(file_text)

    lines = [
        "# Account Statement Summary",
        "",
        f"**Period:** {_extract_statement_period(file_text, fields)}",
        f"**Account:** {_extract_statement_account(file_text, fields)}",
        f"**Type:** {_extract_statement_account_type(file_text)}",
        f"**Currency:** {currency}",
        "",
        "## Balance",
        f"Opening balance: {_format_money(opening_balance, currency)}",
        f"Closing balance: {_format_money(closing_balance, currency)}",
        f"Net change: {_format_money(net_change, currency)}",
        "",
        "## Transactions",
    ]

    if transactions:
        lines.extend(["| Date | Label | Amount | Type |", "|---|---|---:|---|"])
        for row in transactions:
            lines.append(
                f"| {row.get('date') or '-'} | {row.get('label') or '-'} | "
                f"{_format_money(row.get('amount'), currency)} | {row.get('type') or '-'} |"
            )
    else:
        lines.append("No transaction table was detected in the extracted text.")

    if net_change is not None:
        lines.extend([
            "",
            "## Quick insight",
            f"The account changed by **{_format_money(net_change, currency)}** during this period.",
        ])

    return "\n".join(lines)


def _column_for(rows: list[dict[str, str]], aliases: set[str]) -> str | None:
    if not rows:
        return None
    for column in rows[0].keys():
        if _normalized_column_name(column) in aliases:
            return column
    return None


def _build_transactions_csv_summary(file_text: str) -> str:
    rows = _csv_rows_from_text(file_text)
    amount_column = _column_for(rows, TRANSACTION_COLUMN_ALIASES["amount"])
    type_column = _column_for(rows, TRANSACTION_COLUMN_ALIASES["type"])
    label_column = _column_for(rows, TRANSACTION_COLUMN_ALIASES["label"])

    total_credits = 0.0
    total_debits = 0.0
    largest_credit: tuple[float, str] | None = None
    largest_debit: tuple[float, str] | None = None

    for row in rows:
        amount = _parse_money_value(row.get(amount_column)) if amount_column else None
        if amount is None:
            continue
        row_type = str(row.get(type_column, "")).lower() if type_column else ""
        label = str(row.get(label_column, "")).strip() if label_column else ""
        is_credit = "credit" in row_type or (not row_type and amount > 0)
        is_debit = "debit" in row_type or amount < 0

        if is_credit:
            credit_amount = abs(amount)
            total_credits += credit_amount
            if largest_credit is None or credit_amount > largest_credit[0]:
                largest_credit = (credit_amount, label)

        if is_debit:
            debit_amount = abs(amount)
            total_debits += debit_amount
            if largest_debit is None or debit_amount > largest_debit[0]:
                largest_debit = (debit_amount, label)

    net_movement = total_credits - total_debits
    largest_debit_text = (
        f"{_format_money(largest_debit[0])} - {largest_debit[1] or 'No label'}"
        if largest_debit else "not found"
    )
    largest_credit_text = (
        f"{_format_money(largest_credit[0])} - {largest_credit[1] or 'No label'}"
        if largest_credit else "not found"
    )

    return "\n".join([
        "# Transaction Analysis",
        "",
        f"**Total credits:** {_format_money(total_credits)}",
        f"**Total debits:** {_format_money(total_debits)}",
        f"**Net movement:** {_format_money(net_movement)}",
        f"**Largest debit:** {largest_debit_text}",
        f"**Largest credit:** {largest_credit_text}",
        "",
        "No payment is prepared. I can act only if you ask me to do something specific.",
    ])


def _build_bill_summary(file_text: str, fields: dict) -> str:
    return "\n".join([
        "# Bill Summary",
        "",
        f"**Provider:** {fields.get('provider') or 'not found'}",
        f"**Reference:** {fields.get('billReference') or 'not found'}",
        f"**Amount:** {_format_money(fields.get('amount'), fields.get('currency') or 'TND')}",
        f"**Due date:** {fields.get('dueDate') or 'not found'}",
        f"**Source account:** {fields.get('sourceAccountId') or 'not found'}",
        "",
        "I can prepare the payment if you ask me to pay it.",
    ])


def _build_complaint_document_summary(fields: dict, file_text: str) -> str:
    description = fields.get("description")
    if not description:
        preview = " ".join(_strip_file_metadata(file_text).split())[:320]
        description = preview or "not found"

    return "\n".join([
        "# Complaint Document Summary",
        "",
        f"**Category:** {fields.get('category') or 'not found'}",
        f"**Description:** {description}",
        "",
        "I can submit this complaint if you ask me to create it.",
    ])


def _build_appointment_document_summary(fields: dict) -> str:
    return "\n".join([
        "# Appointment Request Summary",
        "",
        f"**Branch:** {fields.get('branch') or 'not found'}",
        f"**Date:** {fields.get('date') or 'not found'}",
        f"**Time:** {fields.get('time') or 'not found'}",
        "",
        "I can book this appointment if you ask me to book it.",
    ])


def _extract_file_analysis_fields(file_text: str, document_type: str | None = None) -> dict:
    fields: dict = {"documentTypeDetected": document_type or "generic_document"}

    if document_type == "bill":
        fields.update(extract_fields("pay_bill", file_text))
    elif document_type == "account_statement":
        # Statements are informational uploads. Do not carry document-generation
        # action fields forward from a statement summary.
        pass
    elif document_type == "complaint_document":
        fields.update(extract_fields("create_complaint", file_text))
    elif document_type == "appointment_request":
        fields.update(extract_fields("book_appointment", file_text))

    return _clean_extracted_fields(fields)


def _build_resource_account_statement_summary(resource_json: dict) -> str:
    currency = resource_json.get("currency") or "TND"
    opening = resource_json.get("openingBalance")
    closing = resource_json.get("closingBalance")
    net_change = (
        float(closing) - float(opening)
        if opening is not None and closing is not None
        else None
    )
    account_type = "current account" if "current" in str(resource_json.get("title", "")).lower() else "account"
    period = resource_json.get("period") or "the requested period"

    lines = [
        "## Account Statement Summary",
        "",
        f"This is your {account_type} statement for {period}.",
        "",
        _markdown_table([
            ("Account", resource_json.get("accountId")),
            ("Period", period),
            ("Opening balance", _format_money(opening, currency)),
            ("Closing balance", _format_money(closing, currency)),
            ("Net change", _format_signed_money(net_change, currency)),
        ]),
    ]

    transactions = resource_json.get("transactions") or []
    if transactions:
        lines.extend([
            "",
            "| Date | Label | Amount | Type |",
            "|---|---|---:|---|",
        ])
        for row in transactions[:8]:
            lines.append(
                f"| {row.get('date') or '-'} | {row.get('label') or '-'} | "
                f"{_format_signed_money(row.get('amount'), currency)} | {row.get('type') or '-'} |"
            )

    return "\n".join(line for line in lines if line is not None)


def _build_resource_summary(request: AgentAnalyzeRequest, file_text: str, extracted_fields: dict) -> str | None:
    resource_json = _resource_json(request)
    resource_type = _resource_type(request)
    currency = resource_json.get("currency") or _extract_currency(file_text, extracted_fields)

    if resource_type == "account_statement":
        return _build_resource_account_statement_summary(resource_json)

    if resource_type == "rib_certificate":
        return "\n\n".join([
            "I found your RIB certificate.",
            _markdown_table([
                ("Holder", resource_json.get("holder") or resource_json.get("customerName")),
                ("Account", resource_json.get("accountId")),
                ("RIB", resource_json.get("rib")),
                ("Branch", resource_json.get("branch")),
                ("Currency", currency),
            ]),
        ])

    if resource_type == "loan_schedule":
        return "\n\n".join([
            "## Loan Payment Schedule",
            _markdown_table([
                ("Loan", resource_json.get("loanId")),
                ("Next due date", resource_json.get("nextDueDate")),
                ("Monthly payment", _format_money(resource_json.get("monthlyPayment"), currency)),
                ("Remaining balance", _format_money(resource_json.get("remainingBalance"), currency)),
            ]),
        ])

    if resource_type == "card_dispute":
        return "\n\n".join([
            "## Card Dispute Status",
            _markdown_table([
                ("Dispute", resource_json.get("disputeId") or resource_json.get("resourceId")),
                ("Status", resource_json.get("status")),
                ("Merchant", resource_json.get("merchant")),
                ("Amount", _format_money(resource_json.get("amount"), currency)),
                ("Date", resource_json.get("date")),
            ]),
        ])

    if resource_type == "transfer_order":
        return "\n\n".join([
            "## Transfer Order",
            _markdown_table([
                ("Beneficiary", resource_json.get("beneficiaryName") or resource_json.get("beneficiaryId")),
                ("From account", resource_json.get("sourceAccountId")),
                ("Amount", _format_money(resource_json.get("amount"), currency)),
                ("Reason", resource_json.get("reason")),
            ]),
        ])

    if resource_type == "account_certificate":
        return "\n\n".join([
            "## Account Ownership Certificate",
            _markdown_table([
                ("Customer", resource_json.get("customerName")),
                ("Account", resource_json.get("accountId")),
                ("Account number", resource_json.get("accountNumber")),
                ("Opened on", resource_json.get("openedOn")),
                ("Status", resource_json.get("status")),
                ("Branch", resource_json.get("branch")),
            ]),
        ])

    if resource_type == "fees_notice":
        return "\n\n".join([
            f"## Bank Fees for {resource_json.get('period') or 'the Requested Period'}",
            _markdown_table([
                ("Monthly fee", _format_money(resource_json.get("monthlyFee"), currency)),
                ("Card fee", _format_money(resource_json.get("cardFee"), currency)),
                ("SMS fee", _format_money(resource_json.get("smsFee"), currency)),
                ("Total fees", _format_money(resource_json.get("totalFees"), currency)),
            ]),
        ])

    if resource_type == "kyc_summary":
        return "\n\n".join([
            "## Customer Profile Summary",
            _markdown_table([
                ("Name", resource_json.get("fullName")),
                ("Email", resource_json.get("email")),
                ("Phone", resource_json.get("phone")),
                ("Risk level", resource_json.get("riskLevel")),
                ("Last update", resource_json.get("lastUpdate")),
            ]),
        ])

    if resource_type == "appointment_confirmation":
        return "\n\n".join([
            "## Branch Appointment",
            _markdown_table([
                ("Status", resource_json.get("status")),
                ("Branch", resource_json.get("branch")),
                ("Date", resource_json.get("date")),
                ("Time", resource_json.get("time")),
                ("Advisor", resource_json.get("advisor")),
                ("Reference", resource_json.get("reference")),
            ]),
        ])

    return None


def _build_resource_direct_answer(
    request: AgentAnalyzeRequest,
    file_text: str,
    extracted_fields: dict,
) -> str | None:
    resource = request.resolvedResourceContext
    resource_json = resource.resourceJson if resource and resource.resourceJson else {}
    resource_type = str(resource_json.get("resourceType") or "").lower()
    normalized_message = request.message.lower()
    currency = _extract_currency(file_text, extracted_fields)

    if "closing balance" in normalized_message:
        closing_balance = resource_json.get("closingBalance")
        if closing_balance is None:
            closing_balance = _extract_statement_balance(file_text, "closing balance")
        period = resource_json.get("period") or _extract_statement_period(file_text, extracted_fields)
        return f"Your closing balance for {period} was **{_format_money(closing_balance, currency)}**."

    if "opening balance" in normalized_message:
        opening_balance = resource_json.get("openingBalance")
        if opening_balance is None:
            opening_balance = _extract_statement_balance(file_text, "opening balance")
        period = resource_json.get("period") or _extract_statement_period(file_text, extracted_fields)
        return f"Your opening balance for {period} was **{_format_money(opening_balance, currency)}**."

    if resource_type == "loan_schedule" and ("due" in normalized_message or "loan" in normalized_message):
        due_date = resource_json.get("nextDueDate") or "not found"
        monthly_payment = _format_money(resource_json.get("monthlyPayment"), resource_json.get("currency", "TND"))
        remaining = _format_money(resource_json.get("remainingBalance"), resource_json.get("currency", "TND"))
        return f"Your next loan payment is due on **{due_date}**. The monthly payment is **{monthly_payment}**."

    if resource_type == "card_dispute" and ("status" in normalized_message or "dispute" in normalized_message):
        status = resource_json.get("status") or "not found"
        dispute_id = resource_json.get("disputeId") or resource_json.get("resourceId") or "not found"
        amount = _format_money(resource_json.get("amount"), resource_json.get("currency", "TND"))
        merchant = resource_json.get("merchant") or "not found"
        return f"Your card dispute **{dispute_id}** is **{status}**. It concerns {merchant} for {amount}."

    if resource_type == "fees_notice" and ("fee" in normalized_message or "fees" in normalized_message):
        total = _format_money(resource_json.get("totalFees"), resource_json.get("currency", "TND"))
        monthly = _format_money(resource_json.get("monthlyFee"), resource_json.get("currency", "TND"))
        card = _format_money(resource_json.get("cardFee"), resource_json.get("currency", "TND"))
        sms = _format_money(resource_json.get("smsFee"), resource_json.get("currency", "TND"))
        period = resource_json.get("period") or "the requested period"
        return (
            f"For {period}, your total bank fees are **{total}**.\n\n"
            f"| Fee | Amount |\n|---|---:|\n"
            f"| Monthly fee | {monthly} |\n"
            f"| Card fee | {card} |\n"
            f"| SMS fee | {sms} |"
        )

    if resource_type == "appointment_confirmation" and (
        "appointment" in normalized_message or "branch" in normalized_message
    ):
        status = resource_json.get("status") or "not found"
        branch = resource_json.get("branch") or "not found"
        date = resource_json.get("date") or "not found"
        time = resource_json.get("time") or "not found"
        advisor = resource_json.get("advisor") or "not found"
        return f"Yes. You have a **{status.lower()}** branch appointment at **{branch}** on **{date}** at **{time}** with {advisor}."

    if resource_type == "rib_certificate" and "rib" in normalized_message:
        holder = resource_json.get("holder") or resource_json.get("customerName") or "not found"
        account = resource_json.get("accountId") or "not found"
        rib = resource_json.get("rib") or "not found"
        branch = resource_json.get("branch") or "not found"
        return "\n\n".join([
            "I found your RIB certificate.",
            _markdown_table([
                ("Holder", holder),
                ("Account", account),
                ("RIB", rib),
                ("Branch", branch),
                ("Currency", resource_json.get("currency") or "TND"),
            ]),
        ])

    if resource_type == "kyc_summary" and (
        "profile" in normalized_message or "customer" in normalized_message or "kyc" in normalized_message
    ):
        return "\n".join([
            "# Customer Profile Summary",
            "",
            f"**Name:** {resource_json.get('fullName') or 'not found'}",
            f"**Email:** {resource_json.get('email') or 'not found'}",
            f"**Phone:** {resource_json.get('phone') or 'not found'}",
            f"**Risk level:** {resource_json.get('riskLevel') or 'not found'}",
            f"**Last update:** {resource_json.get('lastUpdate') or 'not found'}",
        ])

    if resource_type == "account_statement" and "movement" in normalized_message:
        opening_balance = resource_json.get("openingBalance")
        closing_balance = resource_json.get("closingBalance")
        net_change = (
            float(closing_balance) - float(opening_balance)
            if opening_balance is not None and closing_balance is not None
            else None
        )
        period = resource_json.get("period") or "the requested period"
        return (
            f"For {period}, the balance moved from **{_format_money(opening_balance, currency)}** "
            f"to **{_format_money(closing_balance, currency)}**, a net change of "
            f"**{_format_signed_money(net_change, currency)}**."
        )

    if "account" in normalized_message and any(
        term in normalized_message for term in ["which", "what", "id", "number"]
    ):
        account = resource_json.get("accountId") or _extract_statement_account(file_text, extracted_fields)
        return f"The account in this resource is {account}."

    if "period" in normalized_message:
        period = resource_json.get("period") or _extract_statement_period(file_text, extracted_fields)
        return f"The statement period is {period}."

    return None


def _build_file_summary_message(
    request: AgentAnalyzeRequest,
    extracted_fields: dict,
) -> str:
    file_text = _get_file_text(request)
    files = request.fileContext.files if request.fileContext else []
    if request.resolvedResourceContext and not files:
        file_names = request.resolvedResourceContext.fileUrl or "the linked resource file"
    else:
        file_names = ", ".join(file.originalName for file in files) or "the uploaded file"
    document_type = extracted_fields.get("documentTypeDetected") or detect_document_type(request)

    if document_type == "scanned_or_image_document":
        if request.resolvedResourceContext:
            return (
                "I found the resource, but I could not extract readable text "
                "from the linked file."
            )
        return "I received the image, but I could not read enough text from it."

    if not file_text:
        return _build_unreadable_file_message(request, file_names)

    if request.resolvedResourceContext:
        direct_answer = _build_resource_direct_answer(request, file_text, extracted_fields)
        if direct_answer:
            return direct_answer
        resource_summary = _build_resource_summary(request, file_text, extracted_fields)
        if resource_summary:
            return resource_summary

    if document_type == "account_statement":
        return _build_account_statement_summary(file_text, extracted_fields)

    if document_type == "transactions_csv":
        return _build_transactions_csv_summary(file_text)

    if document_type == "bill":
        return _build_bill_summary(file_text, extracted_fields)

    if document_type == "complaint_document":
        return _build_complaint_document_summary(extracted_fields, file_text)

    if document_type == "appointment_request":
        return _build_appointment_document_summary(extracted_fields)

    preview = " ".join(file_text.split())
    if len(preview) > 420:
        preview = f"{preview[:420]}..."

    return f"# Document Summary\n\n**File:** {file_names}\n\n{preview}"


def build_assistant_message(
    intent: str,
    action: AvailableAction | None,
    missing_fields: list[str] | None = None,
) -> str:
    if intent == "unknown" or action is None:
        return (
            "I can help with banking services such as accounts, documents, "
            "transfers, bills, complaints, and appointments."
        )

    missing_fields = missing_fields or []

    if intent == "make_transfer":
        if "sourceAccountId" in missing_fields and "beneficiaryId" in missing_fields:
            return _build_missing_fields_message(
                "I can prepare the transfer, but",
                missing_fields,
            )
        if missing_fields:
            return _build_missing_fields_message(
                "I can prepare the transfer, but",
                missing_fields,
            )
        return "**Transfer request understood**\n\nI can help prepare this transfer."

    if intent == "pay_bill":
        if not missing_fields:
            return "**Bill payment request understood**\n\nI can help prepare this payment."
        return _build_missing_fields_message(
            "I can prepare the bill payment, but",
            missing_fields,
        )

    if missing_fields:
        intro_by_intent = {
            "book_appointment": "I can book the appointment, but",
            "generate_document": "I can generate the document, but",
            "create_complaint": "I can prepare the complaint, but",
            "check_complaint_status": "I can check the complaint status, but",
            "check_balance": "I can check the balance, but",
        }
        return _build_missing_fields_message(
            intro_by_intent.get(
                intent,
                "I need a few details before I can continue:",
            ),
            missing_fields,
        )

    return "**Request understood**\n\nI can assist you with this banking action."


# ---------------------------------------------------------------------------
# Mode analyzers
# ---------------------------------------------------------------------------

def analyze_uploaded_file(request: AgentAnalyzeRequest) -> dict:
    """agentMode: file_analysis — summarize uploaded file content."""
    language = detect_language(request.message)
    file_text = _get_file_text(request)
    document_type = detect_document_type(request)
    extracted_fields = (
        _extract_file_analysis_fields(file_text, document_type)
        if file_text
        else {"documentTypeDetected": document_type}
    )
    extracted_fields = _attach_file_source_metadata(
        extracted_fields,
        request,
        document_type,
    )
    extracted_fields = _attach_resource_source_metadata(extracted_fields, request)

    return {
        "source": "file_context",
        "language": language,
        "agentMode": "file_analysis",
        "intent": "file_analysis",
        "actionName": None,
        "documentTypeDetected": document_type,
        "confidence": 0.9,
        "missingFields": [],
        "extractedFields": extracted_fields,
        "requiredTool": "none",
        "toolInput": _resource_tool_input(request),
        "assistantMessage": _build_file_summary_message(request, extracted_fields),
    }


def analyze_file_generation(request: AgentAnalyzeRequest) -> dict:
    """agentMode: file_generation — backend will generate a downloadable file."""
    language = detect_language(request.message)
    file_type = _detect_output_file_type(request.message)
    title = _extract_file_title(request.message)
    return {
        "source": "rule_based",
        "language": language,
        "agentMode": "file_generation",
        "intent": "generate_file",
        "actionName": None,
        "confidence": 0.85,
        "missingFields": [],
        "extractedFields": {},
        "requiredTool": "file_generator",
        "toolInput": {
            "fileType": file_type,
            "title": title,
            "content": "",
        },
        "assistantMessage": f"Generating your {file_type.upper()} file...",
    }


def analyze_message_rule_based(request: AgentAnalyzeRequest) -> dict:
    """Pure rule-based analysis for banking intents. Returns informational_answer if no match."""
    if _is_file_analysis_request(request):
        return analyze_uploaded_file(request)

    language = detect_language(request.message)
    document_type = detect_document_type(request) if _has_document_context(request) else None

    if document_type == "scanned_or_image_document":
        return analyze_uploaded_file(request)

    context_intent = _infer_intent_from_context(request)
    if context_intent:
        intent, confidence = context_intent, 0.9
    else:
        intent, confidence = detect_intent(request.message)
        document_intent = _infer_intent_from_document_request(
            request.message,
            document_type,
        )
        if document_intent and (intent in {"unknown", "informational_answer"} or confidence < 0.88):
            intent, confidence = document_intent
    action = find_available_action(intent, request.availableActions)

    if intent == "unknown" or action is None:
        return {
            "source": "rule_based",
            "language": language,
            "agentMode": "informational_answer",
            "intent": "informational_answer",
            "actionName": None,
            "documentTypeDetected": document_type,
            "confidence": 0.3 if intent == "unknown" else 0.5,
            "missingFields": [],
            "extractedFields": {},
            "requiredTool": "none",
            "toolInput": {},
            "assistantMessage": build_assistant_message(intent, action),
        }

    extracted_fields = _contextual_fields_for_intent(intent, request)
    missing_fields = calculate_missing_fields(action, extracted_fields)
    assistant_message = _build_action_message_for_context(
        request,
        intent,
        action,
        missing_fields,
        extracted_fields,
    )

    return {
        "source": "rule_based",
        "language": language,
        "agentMode": "banking_action",
        "intent": intent,
        "actionName": action.name,
        "documentTypeDetected": document_type,
        "confidence": confidence,
        "missingFields": missing_fields,
        "extractedFields": extracted_fields,
        "requiredTool": "connector_action",
        "toolInput": _resource_tool_input(request),
        "assistantMessage": assistant_message,
    }


# ---------------------------------------------------------------------------
# Pending-action continuation
# ---------------------------------------------------------------------------
# Banking intents that, when detected with high confidence, should start a new
# action instead of being absorbed as an answer to a pending question.
BANKING_ACTION_INTENTS = {
    "check_balance",
    "pay_bill",
    "make_transfer",
    "generate_document",
    "create_complaint",
    "check_complaint_status",
    "book_appointment",
}


def _continuation_intro(intent: str) -> str:
    return {
        "check_balance": "I can check the balance, but",
        "pay_bill": "I can prepare the bill payment, but",
        "make_transfer": "I can prepare the transfer, but",
        "generate_document": "I can generate the document, but",
        "create_complaint": "I can prepare the complaint, but",
        "check_complaint_status": "I can check the complaint status, but",
        "book_appointment": "I can book the appointment, but",
    }.get(intent, "I can help, but")


def _try_pending_action_continuation(request: AgentAnalyzeRequest) -> dict | None:
    """Treat a short reply as the answer to a pending banking question.

    When the previous turn asked for a missing field, the next user message
    (e.g. "acc_002", "10:00") usually supplies it rather than starting a new
    request. We merge it into the fields collected so far and continue the same
    action — unless the message clearly starts a different banking action.
    """
    pending = request.agentContext.pendingAction if request.agentContext else None
    if not pending or not pending.actionName:
        return None

    action = find_available_action(pending.actionName, request.availableActions)
    if action is None:
        return None

    # A clear, high-confidence new banking intent wins over the pending one.
    detected_intent, detected_confidence = detect_intent(request.message)
    if (
        detected_intent in BANKING_ACTION_INTENTS
        and detected_intent != pending.actionName
        and detected_confidence >= 0.82
    ):
        return None

    collected = pending.collectedFields or {}
    context_fields = _get_agent_context_fields(request)
    newly_extracted = extract_fields(pending.actionName, request.message)

    merged_fields = _clean_extracted_fields(
        {**context_fields, **collected, **newly_extracted}
    )
    missing_fields = calculate_missing_fields(action, merged_fields)
    assistant_message = _build_action_message_for_context(
        request,
        pending.actionName,
        action,
        missing_fields,
        merged_fields,
    )

    return {
        "source": "pending_action_continuation",
        "language": detect_language(request.message),
        "agentMode": "banking_action",
        "intent": pending.actionName,
        "actionName": action.name,
        "documentTypeDetected": None,
        "confidence": 0.9,
        "missingFields": missing_fields,
        "extractedFields": merged_fields,
        "requiredTool": "connector_action",
        "toolInput": {},
        "assistantMessage": assistant_message,
    }


# ---------------------------------------------------------------------------
# Ollama result validation
# ---------------------------------------------------------------------------

def _normalize_confidence(value) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        confidence = 0.5
    return max(0.0, min(1.0, confidence))


def _clean_extracted_fields(extracted_fields: dict) -> dict:
    return {
        key: value
        for key, value in extracted_fields.items()
        if value is not None and not (isinstance(value, str) and value.strip() == "")
    }


def _merge_extracted_fields(
    action_name: str,
    rule_based_fields: dict,
    model_fields: dict,
) -> dict:
    clean_model_fields = _clean_extracted_fields(model_fields)

    if action_name == "create_complaint":
        return {
            **clean_model_fields,
            **rule_based_fields,
        }

    return {
        **rule_based_fields,
        **clean_model_fields,
    }


def _validate_ollama_result(
    raw_result: dict,
    request: AgentAnalyzeRequest,
) -> dict:
    language = raw_result.get("language", "unknown")
    intent = raw_result.get("intent", "unknown")
    action_name = raw_result.get("actionName")
    extracted_fields = raw_result.get("extractedFields", {})
    document_type = raw_result.get("documentTypeDetected") or (
        detect_document_type(request) if _has_document_context(request) else None
    )
    assistant_message = raw_result.get("assistantMessage")

    if language not in VALID_LANGUAGES:
        language = "unknown"

    if intent not in VALID_INTENTS:
        raise OllamaServiceError("Ollama returned an invalid intent")

    if not isinstance(extracted_fields, dict):
        raise OllamaServiceError("Ollama extractedFields must be an object")

    if intent in ("unknown", "informational_answer") or action_name is None:
        return {
            "source": "ollama",
            "language": language,
            "agentMode": "informational_answer",
            "intent": "informational_answer",
            "actionName": None,
            "documentTypeDetected": document_type,
            "confidence": _normalize_confidence(raw_result.get("confidence", 0.3)),
            "missingFields": [],
            "extractedFields": extracted_fields,
            "requiredTool": "none",
            "toolInput": _resource_tool_input(request),
            "assistantMessage": assistant_message
            or build_assistant_message("unknown", None),
        }

    if action_name != intent:
        raise OllamaServiceError("Ollama actionName must match intent")

    action = find_available_action(action_name, request.availableActions)

    if action is None:
        raise OllamaServiceError("Ollama returned an unavailable action")

    extracted_fields = _merge_extracted_fields(
        action_name,
        _contextual_fields_for_intent(action_name, request),
        extracted_fields,
    )
    missing_fields = calculate_missing_fields(action, extracted_fields)
    generated_message = _build_action_message_for_context(
        request,
        intent,
        action,
        missing_fields,
        extracted_fields,
    )

    return {
        "source": "ollama",
        "language": language,
        "agentMode": "banking_action",
        "intent": intent,
        "actionName": action.name,
        "documentTypeDetected": document_type,
        "confidence": _normalize_confidence(raw_result.get("confidence", 0.5)),
        "missingFields": missing_fields,
        "extractedFields": extracted_fields,
        "requiredTool": "connector_action",
        "toolInput": _resource_tool_input(request),
        "assistantMessage": generated_message if missing_fields else (
            assistant_message or generated_message
        ),
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def analyze_message(request: AgentAnalyzeRequest) -> dict:
    """
    Classify the request into one of the supported agent modes and return structured data.

    Priority order:
      1. file_analysis     — uploaded file + analysis keywords
      2. file_generation   — file export/generation keywords (non-banking)
      3. banking_action    — detected banking intent (Ollama or rule-based)
      4. informational_answer — default fallback
    """
    # 1. File analysis
    if _is_file_analysis_request(request):
        return analyze_uploaded_file(request)

    if _is_resource_analysis_request(request):
        return analyze_uploaded_file(request)

    # 2. File generation (checked before banking to avoid Ollama interference)
    #    _is_file_generation_request already excludes banking document keywords
    if _is_file_generation_request(request.message):
        return analyze_file_generation(request)

    # 3. Pending-action continuation: a short reply that answers the field we
    #    asked for last turn continues the same action deterministically.
    continuation = _try_pending_action_continuation(request)
    if continuation is not None:
        return continuation

    rule_based_result = analyze_message_rule_based(request)

    # 3. High-confidence deterministic banking detection should not be
    # overridden by model variance. The backend still owns execution safety.
    if (
        rule_based_result["agentMode"] == "banking_action"
        and rule_based_result["confidence"] >= 0.82
    ):
        return rule_based_result

    if rule_based_result["agentMode"] == "file_analysis":
        return rule_based_result

    if rule_based_result["agentMode"] == "informational_answer":
        # A file was uploaded but no banking action was detected: read the file
        # and summarize it. This always surfaces the document's extracted fields
        # so they are remembered for follow-up turns ("pay the bill I provided").
        if _has_uploaded_files(request):
            return analyze_uploaded_file(request)
        return rule_based_result

    # 4. Banking intent detection (Ollama when enabled, rule-based fallback)
    if settings.USE_OLLAMA:
        try:
            ollama_result = analyze_with_ollama(request)
            validated_result = _validate_ollama_result(ollama_result, request)

            if (
                validated_result["agentMode"] == "informational_answer"
                and rule_based_result["agentMode"] == "banking_action"
            ):
                return rule_based_result

            return validated_result
        except (OllamaServiceError, ValueError, TypeError, KeyError):
            pass

    # 5. Rule-based banking / informational fallback
    return rule_based_result
