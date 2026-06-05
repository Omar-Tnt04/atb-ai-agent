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
        "account details",
        "account information",
        "account info",
        "show my account",
        "show my accounts",
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
        "rendez-vous",
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
        r"\bpay\b.{0,40}\b(?:bill|invoice)\b",
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


def _is_capabilities_question(message: str) -> bool:
    text = re.sub(r"\s+", " ", str(message or "").lower()).strip()
    return bool(
        re.fullmatch(r"(help|services|hello help|hi help|hey help)", text)
        or re.search(r"\bwhat\s+can\s+you\s+do\b", text)
        or re.search(r"\bwhat\s+do\s+you\s+do\b", text)
        or re.search(r"\bhow\s+can\s+you\s+help\b", text)
        or re.search(r"\bhow\s+can\s+you\s+assist\b", text)
        or re.search(r"\bwhat\s+can\s+you\s+help\s+(?:me\s+)?with\b", text)
        or re.search(r"\bshow\s+me\s+your\s+(?:capabilities|services)\b", text)
    )


def _matches_any(text: str, patterns: list[str]) -> bool:
    import re

    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


def _is_account_details_request(message: str) -> bool:
    normalized_message = message.lower()
    return _matches_any(
        normalized_message,
        [
            r"\baccounts?\b.*\b(details?|information|info|summary|status)\b",
            r"\b(details?|information|info|summary|status)\b.*\baccounts?\b",
            r"\b(show|view|give|get|display|list)\b.*\bmy\s+accounts?\b",
            r"\b(show|view|give|get|display|list)\b.*\baccounts?\b",
        ],
    )


def _is_appointment_booking_message(message: str) -> bool:
    normalized_message = message.lower()
    return _matches_any(
        normalized_message,
        [
            r"\b(book|schedule|reserve)\b.{0,40}\b(appointment|meeting|visit|rendez-vous)\b",
            r"\b(create|make)\b.{0,20}\b(an?\s+)?appointment\b",
            r"\b(appointment|meeting|visit|rendez-vous)\b.{0,40}\b(book|scheduled?|reserved?)\b",
        ],
    )


def _is_appointment_lookup_message(message: str) -> bool:
    normalized_message = message.lower()
    if _is_appointment_booking_message(message):
        return False

    return _matches_any(
        normalized_message,
        [
            r"^\s*do\s+i\s+have\b.*\b(appointment|meeting|visit|rendez-vous)\b",
            r"\b(appointment|meeting|visit|rendez-vous)\b.*\b(status|confirmed|confirmation|existing)\b",
            r"\b(status|confirmed|confirmation|existing)\b.*\b(appointment|meeting|visit|rendez-vous)\b",
            r"\bcard\s+pickup\b.*\bappointment\b",
            r"\bbranch\s+appointment\b.*\b(confirmed|have)\b",
        ],
    )


def detect_intent(message: str) -> tuple[str, float]:
    normalized_message = message.lower()

    if _matches_any(normalized_message, [r"\bcmp(?:-demo)?-\d{4}-\d{3,6}\b"]):
        return "check_complaint_status", 0.92

    if _has_any(normalized_message, ["complaint status", "claim status", "track complaint"]):
        return "check_complaint_status", 0.84

    if _has_any(normalized_message, ["available slots", "appointment slots", "show slots", "available appointments"]):
        return "list_appointment_slots", 0.86

    if _is_appointment_lookup_message(message):
        return "unknown", 0.35

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

    if _is_account_details_request(message):
        return "check_balance", 0.88

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
            r"\bprepare\s+(?:the\s+)?transfer\b",
            r"\btransfer\s+order\b",
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

    if _is_appointment_booking_message(message):
        return "book_appointment", 0.82

    for intent, keywords in INTENT_KEYWORDS.items():
        if intent == "book_appointment" and _is_appointment_lookup_message(message):
            continue
        if any(keyword in normalized_message for keyword in keywords):
            return intent, 0.72

    if _is_capabilities_question(message):
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


def _option(label: str, value: str | None = None) -> dict:
    return {
        "label": label,
        "value": value or label,
        "action": "prompt",
        "prompt": label,
    }


def _clarification_quick_actions(intent: str, missing_fields: list[str]) -> list[dict]:
    first_missing = missing_fields[0] if missing_fields else None

    if intent == "check_balance" and first_missing == "accountId":
        return [
            _option("Current account", "acc_001"),
            _option("Savings account", "acc_002"),
            _option("acc_001", "acc_001"),
            _option("acc_002", "acc_002"),
        ]

    if intent == "pay_bill":
        if first_missing == "provider":
            return [
                _option("SONEDE"),
                _option("STEG"),
                _option("Telecom", "TELECOM"),
                _option("Internet", "INTERNET"),
            ]
        if first_missing == "sourceAccountId":
            return [
                _option("Current account", "acc_001"),
                _option("Savings account", "acc_002"),
                _option("acc_001", "acc_001"),
                _option("acc_002", "acc_002"),
            ]

    if intent == "book_appointment" and first_missing == "branch":
        return [
            _option("Tunis Centre"),
            _option("Ariana"),
            _option("Sfax"),
            _option("Online appointment"),
        ]

    if intent == "create_complaint" and first_missing == "category":
        return [
            _option("Failed transfer"),
            _option("Card issue"),
            _option("Account access issue"),
            _option("Other"),
        ]

    return []


def _merge_quick_actions(tool_input: dict, quick_actions: list[dict]) -> dict:
    if not quick_actions:
        return tool_input

    existing_actions = tool_input.get("quickActions") if isinstance(tool_input, dict) else None
    merged_actions = [
        *(existing_actions if isinstance(existing_actions, list) else []),
        *quick_actions,
    ]

    return {
        **(tool_input or {}),
        "quickActions": merged_actions,
    }


def _action_tool_input(
    request: AgentAnalyzeRequest,
    intent: str,
    missing_fields: list[str],
) -> dict:
    return _merge_quick_actions(
        _resource_tool_input(request),
        _clarification_quick_actions(intent, missing_fields),
    )


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


def _format_grouped_money(value, currency: str = "TND") -> str:
    amount = _parse_money_value(value)
    if amount is None:
        return str(value or "").strip()
    return f"{amount:,.3f} {currency or 'TND'}"


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

    def clean_cell(value: object) -> str:
        return (
            str(value)
            .replace("\r\n", " ")
            .replace("\n", " ")
            .replace("|", "\\|")
            .strip()
        )

    return "\n".join([
        "| Field | Value |",
        "|---|---|",
        *[f"| {clean_cell(label)} | {clean_cell(value)} |" for label, value in usable_rows],
    ])


TECHNICAL_RESOURCE_FIELDS = {
    "body",
    "content",
    "debug",
    "documenturl",
    "environment",
    "fileurl",
    "jsonurl",
    "keywords",
    "localpathhint",
    "metadata",
    "mimetype",
    "note",
    "resourceid",
    "resourcetype",
    "resourceurl",
    "service",
    "synthetic",
    "text",
    "url",
}

BUSINESS_FIELD_PRIORITY = [
    "card",
    "cardType",
    "cardNumber",
    "currentLimit",
    "availableLimit",
    "limit",
    "currency",
    "status",
    "effectiveDate",
    "lastUpdate",
    "nextReviewDate",
    "statementDate",
    "paymentDueDate",
    "minimumPayment",
    "customerId",
    "fullName",
    "customerName",
    "segment",
    "email",
    "phone",
    "primaryBranch",
    "relationshipStartDate",
    "riskLevel",
    "preferredLanguage",
    "formId",
    "countryOfResidence",
    "taxIdStatus",
    "signatureStatus",
    "receiptId",
    "accountId",
    "atmLocation",
    "amount",
    "date",
    "time",
    "requestId",
    "reference",
    "reason",
    "requestedBranch",
    "branch",
    "fee",
]

GENERIC_FIELD_CONTAINERS = {
    "fields",
    "extractedfields",
    "metadata",
    "data",
    "content",
    "parsedfields",
}

GENERIC_FIELD_PRIORITY = [
    "name",
    "fullname",
    "customername",
    "segment",
    "branch",
    "primarybranch",
    "preferredlanguage",
    "amount",
    "limit",
    "currentlimit",
    "availablelimit",
    "fee",
    "rate",
    "premium",
    "status",
    "requeststatus",
    "signaturestatus",
    "risklevel",
    "duedate",
    "paymentduedate",
    "statementdate",
    "nextexecutiondate",
    "appointmentdate",
    "startdate",
    "relationshipstartdate",
    "enddate",
    "requestid",
    "receiptid",
    "billid",
    "certificateid",
    "policyid",
    "reference",
]

GENERIC_LABEL_OVERRIDES = {
    "fullname": "Full name",
    "primarybranch": "Primary branch",
    "preferredlanguage": "Preferred language",
    "currentlimit": "Current limit",
    "availablelimit": "Available limit",
    "paymentduedate": "Payment due date",
}

IMPORTANT_RESOURCE_FIELDS = {
    "amount",
    "availablelimit",
    "balance",
    "closingbalance",
    "currentlimit",
    "fee",
    "limit",
    "minimumpayment",
    "monthlypayment",
    "remainingbalance",
    "signaturestatus",
    "status",
    "totalfees",
}


def _normalized_resource_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(key or "").lower())


def _is_technical_resource_field(key: str) -> bool:
    normalized_key = _normalized_resource_key(key)
    return (
        normalized_key in TECHNICAL_RESOURCE_FIELDS
        or normalized_key.startswith("debug")
        or normalized_key.startswith("metadata")
        or normalized_key.endswith("metadata")
    )


def _resource_title(resource_json: dict, fallback: str = "Resource Details") -> str:
    title = str(resource_json.get("title") or "").strip()
    return title or fallback


def _format_resource_label(key: str) -> str:
    return re.sub(r"([A-Z])", r" \1", str(key)).replace("_", " ").strip().title()


def _humanize_resource_label(key: str) -> str:
    normalized_key = _normalized_resource_key(key)
    if normalized_key in GENERIC_LABEL_OVERRIDES:
        return GENERIC_LABEL_OVERRIDES[normalized_key]

    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(key or ""))
    words = re.sub(r"[_\-]+", " ", words).strip()
    if not words:
        return ""

    label = words.lower().capitalize()
    for acronym in ("id", "rib", "iban", "atm", "pdf"):
        label = re.sub(rf"\b{acronym}\b", acronym.upper(), label, flags=re.IGNORECASE)
    return label


def _format_business_value(key: str, value) -> str:
    if isinstance(value, bool):
        text = "Yes" if value else "No"
    elif isinstance(value, list):
        scalar_values = [
            str(item).strip()
            for item in value
            if item is not None and not isinstance(item, (dict, list))
            and str(item).strip()
        ]
        text = ", ".join(scalar_values[:8])
    else:
        text = str(value).strip()

    if not text:
        return ""

    if _normalized_resource_key(key) in IMPORTANT_RESOURCE_FIELDS:
        return f"**{text}**"

    return text


def _is_scalar_resource_value(value) -> bool:
    return value is not None and not isinstance(value, (dict, list, tuple, set))


def _stringify_resource_value(value) -> str:
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, list):
        scalar_values = [
            str(item).strip()
            for item in value
            if _is_scalar_resource_value(item) and str(item).strip()
        ]
        return ", ".join(scalar_values[:8])
    return str(value).strip()


def _add_generic_field(
    fields_by_key: dict[str, dict],
    key: str,
    value,
    order: int,
    *,
    source_depth: int = 0,
) -> int:
    normalized_key = _normalized_resource_key(key)
    if not normalized_key or _is_technical_resource_field(key) or normalized_key == "title":
        return order

    if isinstance(value, list):
        text = _stringify_resource_value(value)
    elif _is_scalar_resource_value(value):
        text = _stringify_resource_value(value)
    else:
        return order

    if not text:
        return order

    candidate = {
        "key": str(key),
        "value": text,
        "rank": _generic_field_rank(str(key)),
        "order": order,
        "sourceDepth": source_depth,
    }
    existing = fields_by_key.get(normalized_key)
    if not existing or (
        candidate["rank"],
        candidate["sourceDepth"],
        candidate["order"],
    ) < (
        existing["rank"],
        existing["sourceDepth"],
        existing["order"],
    ):
        fields_by_key[normalized_key] = candidate
    return order + 1


def _generic_field_rank(key: str) -> int:
    normalized_key = _normalized_resource_key(key)
    if normalized_key in GENERIC_FIELD_PRIORITY:
        return GENERIC_FIELD_PRIORITY.index(normalized_key)

    identity_terms = ("name", "segment", "branch", "language")
    financial_terms = ("amount", "limit", "fee", "rate", "premium", "balance", "payment")
    status_terms = ("status", "risk")
    date_terms = ("date", "start", "end", "execution", "update")
    identifier_terms = ("id", "reference", "receipt", "certificate", "policy", "bill")

    for offset, terms in enumerate((
        identity_terms,
        financial_terms,
        status_terms,
        date_terms,
        identifier_terms,
    )):
        if any(term in normalized_key for term in terms):
            return 100 + offset * 100

    if normalized_key == "category":
        return 900
    return 700


def _field_value_from_row(row: dict) -> tuple[str, object] | None:
    if not isinstance(row, dict):
        return None
    label = (
        row.get("field")
        or row.get("Field")
        or row.get("label")
        or row.get("Label")
        or row.get("key")
        or row.get("Key")
        or row.get("name")
        or row.get("Name")
    )
    value = row.get("value") if "value" in row else row.get("Value")
    if label is None or value is None:
        return None
    return str(label), value


def _collect_fields_from_string(
    text: str,
    fields_by_key: dict[str, dict],
    order: int,
    source_depth: int,
) -> int:
    lines = [line.strip() for line in str(text or "").splitlines() if line.strip()]

    for index, line in enumerate(lines):
        if "|" not in line:
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) < 2:
            continue
        if index + 1 < len(lines) and re.fullmatch(r"\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?.*", lines[index + 1]):
            continue
        if cells[0].lower() in {"field", "label", "key", "name"} and cells[1].lower() == "value":
            continue
        order = _add_generic_field(fields_by_key, cells[0], cells[1], order, source_depth=source_depth)

    for line in lines:
        match = re.match(r"^([A-Za-z][A-Za-z0-9 _/\-]{1,60})\s*[:=]\s*(.+?)\s*$", line)
        if match:
            order = _add_generic_field(fields_by_key, match.group(1), match.group(2), order, source_depth=source_depth)

    return order


def _collect_generic_resource_fields(data, fields_by_key: dict[str, dict] | None = None, order: int = 0, depth: int = 0):
    fields_by_key = fields_by_key if fields_by_key is not None else {}
    if depth > 4:
        return fields_by_key, order

    if isinstance(data, dict):
        row_value = _field_value_from_row(data)
        if row_value:
            key, value = row_value
            order = _add_generic_field(fields_by_key, key, value, order, source_depth=depth)
            return fields_by_key, order

        for key, value in data.items():
            normalized_key = _normalized_resource_key(key)
            if normalized_key == "title":
                continue
            if normalized_key in GENERIC_FIELD_CONTAINERS and isinstance(value, (dict, list)):
                fields_by_key, order = _collect_generic_resource_fields(value, fields_by_key, order, depth + 1)
            elif normalized_key in GENERIC_FIELD_CONTAINERS and isinstance(value, str):
                order = _collect_fields_from_string(value, fields_by_key, order, depth + 1)
            elif _is_technical_resource_field(key):
                continue
            elif _is_scalar_resource_value(value) or (
                isinstance(value, list) and all(_is_scalar_resource_value(item) for item in value)
            ):
                order = _add_generic_field(fields_by_key, key, value, order, source_depth=depth)
            elif isinstance(value, list):
                fields_by_key, order = _collect_generic_resource_fields(value, fields_by_key, order, depth + 1)
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                row_value = _field_value_from_row(item)
                if row_value:
                    key, value = row_value
                    order = _add_generic_field(fields_by_key, key, value, order, source_depth=depth)
                else:
                    fields_by_key, order = _collect_generic_resource_fields(item, fields_by_key, order, depth + 1)
            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                order = _add_generic_field(fields_by_key, str(item[0]), item[1], order, source_depth=depth)

    return fields_by_key, order


def _generic_resource_rows(resource_json: dict, limit: int = 8) -> list[tuple[str, object]]:
    fields_by_key, _ = _collect_generic_resource_fields(resource_json)
    candidates = sorted(fields_by_key.values(), key=lambda item: (item["rank"], item["order"]))

    non_category = [
        item for item in candidates
        if _normalized_resource_key(item["key"]) != "category"
    ]
    if non_category:
        candidates = non_category

    return [
        (_humanize_resource_label(item["key"]), item["value"])
        for item in candidates[:limit]
        if _humanize_resource_label(item["key"])
    ]


def _generic_resource_value(resource_json: dict, *keys: str):
    fields_by_key, _ = _collect_generic_resource_fields(resource_json)
    for key in keys:
        item = fields_by_key.get(_normalized_resource_key(key))
        if item and str(item.get("value") or "").strip():
            return item["value"]
    return None


def _format_generic_resource_summary(resource_json: dict, limit: int = 8) -> str | None:
    if not resource_json:
        return None

    title = _resource_title(resource_json)
    rows = _generic_resource_rows(resource_json, limit=limit)
    if not rows:
        return f"I found your **{title}**."

    return "\n\n".join([
        f"I found your **{title}**.",
        _markdown_bullets(rows),
    ])


def _resource_first_value(resource_json: dict, *keys: str):
    for key in keys:
        value = resource_json.get(key)
        if value is not None and str(value).strip() != "":
            return value
    return None


def _bold_value(value) -> str:
    raw_text = str(value or "").strip()
    if raw_text.startswith("**") and raw_text.endswith("**"):
        return raw_text
    text = (
        raw_text
        .replace("\r\n", " ")
        .replace("\n", " ")
        .replace("|", "\\|")
        .replace("*", "\\*")
        .strip()
    )
    return f"**{text}**" if text else ""


def _markdown_bullets(rows: list[tuple[str, object]]) -> str:
    lines = []
    for label, value in rows:
        if value is None or str(value).strip() == "":
            continue
        lines.append(f"- {label}: {_bold_value(value)}")
    return "\n".join(lines)


def _compact_join(parts: list[object], separator: str = " ") -> str:
    return separator.join(
        str(part).strip()
        for part in parts
        if part is not None and str(part).strip()
    ).strip()


def _resource_reference_line(resource_json: dict, *keys: str) -> str:
    reference = _resource_first_value(resource_json, *keys, "reference", "requestId", "receiptId")
    return f"Reference: {_bold_value(reference)}" if reference else ""


def _appointment_label(resource_json: dict, resource_type: str) -> str:
    purpose = str(resource_json.get("purpose") or resource_json.get("title") or "").lower()
    if resource_type == "card_pickup_appointment" or "card pickup" in purpose:
        return "card pickup appointment"
    return "branch appointment"


def _format_appointment_resource(resource_json: dict, resource_type: str) -> str:
    label = _appointment_label(resource_json, resource_type)
    status = resource_json.get("status")
    branch = resource_json.get("branch")
    date = resource_json.get("date")
    time = resource_json.get("time")
    advisor = resource_json.get("advisor")

    intro = (
        f"Yes, your {_bold_value(label)} is {_bold_value(str(status).lower())}."
        if status
        else f"Yes, I found your {_bold_value(label)}."
    )

    schedule_parts = []
    if branch:
        schedule_parts.append(f"at {_bold_value(branch)}")
    if date:
        schedule_parts.append(f"on {_bold_value(date)}")
    if time:
        schedule_parts.append(f"at {_bold_value(time)}")

    schedule = ""
    if schedule_parts:
        schedule = f"It is scheduled {' '.join(schedule_parts)}"
        if advisor:
            schedule += f" with advisor {_bold_value(advisor)}"
        schedule += "."
    elif advisor:
        schedule = f"Advisor: {_bold_value(advisor)}"

    return "\n\n".join(filter(None, [
        intro,
        schedule,
        _resource_reference_line(resource_json),
    ])).strip()


def _format_card_service_request(resource_json: dict) -> str:
    status = resource_json.get("status")
    request_id = resource_json.get("requestId") or resource_json.get("reference")
    card = resource_json.get("card") or resource_json.get("cardNumber")
    branch = resource_json.get("requestedBranch") or resource_json.get("branch")

    intro_parts = ["Your", _bold_value("debit card replacement request")]
    if request_id:
        intro_parts.append(_bold_value(request_id))
    intro = _compact_join(intro_parts)
    intro += f" is {_bold_value(str(status).lower())}." if status else " was found."

    details = []
    if card:
        details.append(f"Card: {_bold_value(card)}")
    if resource_json.get("reason"):
        details.append(f"Reason: {_bold_value(resource_json.get('reason'))}")
    if branch:
        details.append(f"Branch: {_bold_value(branch)}")
    if resource_json.get("fee"):
        details.append(f"Fee: {_bold_value(resource_json.get('fee'))}")

    return "\n\n".join(filter(None, [
        intro,
        ". ".join(details) + "." if details else "",
        "Next step: **confirm the replacement request** if the details are correct.",
    ])).strip()


def _format_checkbook_request(resource_json: dict) -> str:
    status = resource_json.get("status")
    request_id = resource_json.get("requestId") or resource_json.get("reference")
    intro = "Your **checkbook request**"
    if request_id:
        intro += f" {_bold_value(request_id)}"
    intro += f" is {_bold_value(str(status).lower())}." if status else " was found."

    details = []
    if resource_json.get("numberOfChecks"):
        details.append(f"for {_bold_value(resource_json.get('numberOfChecks'))} checks")
    if resource_json.get("accountId"):
        details.append(f"on account {_bold_value(resource_json.get('accountId'))}")
    branch = resource_json.get("requestedBranch") or resource_json.get("branch")
    if branch:
        details.append(f"at {_bold_value(branch)}")
    request_date = resource_json.get("requestDate") or resource_json.get("requestedOn") or resource_json.get("date")
    if request_date:
        details.append(f"requested on {_bold_value(request_date)}")

    ready_date = (
        resource_json.get("estimatedReadyDate")
        or resource_json.get("estimatedAvailability")
        or resource_json.get("availableOn")
    )

    return "\n\n".join(filter(None, [
        intro,
        f"It is {' '.join(details)}." if details else "",
        f"Estimated ready date: {_bold_value(ready_date)}" if ready_date else "",
    ])).strip()


def _format_card_limit_notice(resource_json: dict) -> str:
    current_limit = (
        _generic_resource_value(resource_json, "currentLimit", "limit", "creditLimit")
        or resource_json.get("currentLimit")
        or resource_json.get("limit")
        or resource_json.get("creditLimit")
    )
    card = _generic_resource_value(resource_json, "card", "cardNumber") or resource_json.get("card") or resource_json.get("cardNumber")
    status = _generic_resource_value(resource_json, "status") or resource_json.get("status")

    intro = "Your credit card limit"
    if card:
        intro += f" for {_bold_value(card)}"
    intro += f" is {_bold_value(current_limit)}." if current_limit else " was found."

    details = []
    if current_limit:
        details.append(f"Current limit: {_bold_value(current_limit)}")
    available_limit = _generic_resource_value(resource_json, "availableLimit") or resource_json.get("availableLimit")
    minimum_payment = _generic_resource_value(resource_json, "minimumPayment") or resource_json.get("minimumPayment")
    payment_due_date = _generic_resource_value(resource_json, "paymentDueDate", "dueDate") or resource_json.get("paymentDueDate")
    if available_limit:
        details.append(f"Available limit: {_bold_value(available_limit)}")
    if status:
        details.append(f"Status: {_bold_value(str(status).lower())}")
    if minimum_payment:
        details.append(f"Minimum payment: {_bold_value(minimum_payment)}")
    if payment_due_date:
        details.append(f"Payment due date: {_bold_value(payment_due_date)}")

    return "\n\n".join(filter(None, [
        intro,
        ". ".join(details) + "." if details else "",
    ])).strip()


def _format_tax_form(resource_json: dict) -> str:
    form_id = resource_json.get("formId") or resource_json.get("reference")
    signature_status = resource_json.get("signatureStatus")
    intro = "Your **tax residency self-certification**"
    if form_id:
        intro += f" {_bold_value(form_id)}"
    intro += f" is {_bold_value(str(signature_status).lower())}." if signature_status else " was found."

    details = []
    if resource_json.get("countryOfResidence"):
        details.append(f"Country of residence: {_bold_value(resource_json.get('countryOfResidence'))}")
    if resource_json.get("taxIdStatus"):
        details.append(f"Tax ID status: {_bold_value(resource_json.get('taxIdStatus'))}")
    if resource_json.get("lastUpdate"):
        details.append(f"Last update: {_bold_value(resource_json.get('lastUpdate'))}")

    return "\n\n".join(filter(None, [
        intro,
        ". ".join(details) + "." if details else "",
    ])).strip()


def _format_receipt_summary(resource_json: dict, resource_type: str) -> str:
    receipt_id = resource_json.get("receiptId") or resource_json.get("reference")
    status = resource_json.get("status")

    if resource_type == "payment_receipt":
        provider = resource_json.get("provider") or "bill"
        intro = f"Your {_bold_value(provider)} payment receipt"
        if receipt_id:
            intro += f" {_bold_value(receipt_id)}"
        intro += f" is {_bold_value(str(status).lower())}." if status else " was found."
        details = [
            f"Amount: {_bold_value(resource_json.get('amount'))}" if resource_json.get("amount") else "",
            f"Bill reference: {_bold_value(resource_json.get('billReference'))}" if resource_json.get("billReference") else "",
            f"Paid on: {_bold_value(resource_json.get('paymentDate'))}" if resource_json.get("paymentDate") else "",
        ]
    elif resource_type == "fx_receipt":
        intro = "Your **foreign currency exchange receipt**"
        if receipt_id:
            intro += f" {_bold_value(receipt_id)}"
        intro += " was found."
        details = [
            f"Converted: {_bold_value(resource_json.get('amountTnd'))} to {_bold_value(resource_json.get('amountEur'))}"
            if resource_json.get("amountTnd") and resource_json.get("amountEur") else "",
            f"Rate: {_bold_value(resource_json.get('rate'))}" if resource_json.get("rate") else "",
            f"Date: {_bold_value(resource_json.get('date'))}" if resource_json.get("date") else "",
        ]
    else:
        intro = "Your **ATM withdrawal receipt**"
        if receipt_id:
            intro += f" {_bold_value(receipt_id)}"
        intro += f" is {_bold_value(str(status).lower())}." if status else " was found."
        details = [
            f"Amount: {_bold_value(resource_json.get('amount'))}" if resource_json.get("amount") else "",
            f"ATM location: {_bold_value(resource_json.get('atmLocation') or resource_json.get('location'))}"
            if resource_json.get("atmLocation") or resource_json.get("location") else "",
            f"Date and time: {_bold_value(_compact_join([resource_json.get('date'), resource_json.get('time')]))}"
            if resource_json.get("date") or resource_json.get("time") else "",
        ]

    return "\n\n".join(filter(None, [
        intro,
        ". ".join(detail for detail in details if detail) + "." if any(details) else "",
    ])).strip()


def _is_summary_request(message: str) -> bool:
    normalized = str(message or "").lower()
    return bool(re.search(r"\b(summarize|summarise|summary|overview|recap)\b", normalized))


def _is_open_document_request(message: str) -> bool:
    normalized = str(message or "").lower()
    return bool(re.search(r"\b(open|download|get|show|view|fetch)\b", normalized))


def _is_activation_how_to_request(message: str) -> bool:
    normalized = str(message or "").lower()
    return bool(
        re.search(r"\bhow\s+(?:do|can)\s+i\b.*\bactivate\b", normalized)
        or re.search(r"\bactivate\b.*\b(atb\s+connect|connect)\b", normalized)
    )


def _is_atb_connect_id_question(message: str) -> bool:
    normalized = str(message or "").lower()
    return bool(
        re.search(r"\bwhat\b.*\b(id|identification|document)\b.*\bneed\b", normalized)
        or re.search(r"\bwhich\b.*\b(id|identification|document)\b.*\bneed\b", normalized)
        or re.search(r"\brequired\s+id\b", normalized)
    )


def _atb_connect_key_points(resource_json: dict) -> str:
    return _markdown_bullets([
        ("Required ID", resource_json.get("requiredId")),
        ("Activation channel", resource_json.get("activationChannel")),
        ("Support", resource_json.get("supportChannel")),
        ("Status", resource_json.get("status")),
    ])


def _atb_connect_steps(resource_json: dict, file_text: str) -> list[str]:
    steps = resource_json.get("steps") or resource_json.get("activationSteps")
    if isinstance(steps, list) and steps:
        return [str(step).strip() for step in steps if str(step).strip()]

    extracted_steps = _extract_numbered_steps(
        file_text,
        "Activation Steps",
        ["Agent Expected Behavior", "Synthetic document"],
    )
    if extracted_steps:
        return extracted_steps

    return [
        "Verify your identity with **CIN or passport**.",
        "Choose branch or online onboarding.",
        "Register your mobile number and email address.",
        "Create your password.",
        "Set up OTP verification.",
        "Review your first login.",
    ]


def _format_atb_connect_resource(
    request: AgentAnalyzeRequest,
    resource_json: dict,
    file_text: str,
) -> str:
    message = request.message
    title = _resource_title(resource_json, "ATB Connect Activation Guide")

    if _is_open_document_request(message) and not _is_summary_request(message):
        return (
            f"I found the ATB Connect guide: **{title}**.\n\n"
            "Use **Download PDF** to open the document."
        )

    if _is_activation_how_to_request(message):
        steps = _atb_connect_steps(resource_json, file_text)
        return "\n\n".join([
            "Here is how to activate **ATB Connect**.",
            "\n".join(f"{index + 1}. {step}" for index, step in enumerate(steps[:8])),
            _atb_connect_key_points(resource_json),
        ]).strip()

    summary_intro = (
        f"I found the latest ATB Connect resource: **{title}**."
        if "latest" in str(message or "").lower()
        else f"I found an ATB Connect resource: **{title}**."
    )
    summary = (
        "This resource explains how a customer can activate ATB Connect through "
        "branch or online onboarding. It covers identity verification, "
        "mobile/email registration, password creation, OTP setup, and first "
        "login review."
    )

    return "\n\n".join([
        summary_intro,
        summary,
        "Key points:",
        _atb_connect_key_points(resource_json),
    ]).strip()


def _business_resource_bullets(resource_json: dict, limit: int = 8) -> str:
    return _markdown_bullets(_business_resource_rows(resource_json, limit))


def _business_resource_rows(resource_json: dict, limit: int = 12) -> list[tuple[str, object]]:
    rows_by_key: dict[str, tuple[str, object]] = {}

    for key, value in resource_json.items():
        if (
            _is_technical_resource_field(key)
            or key == "title"
            or value is None
            or isinstance(value, dict)
        ):
            continue

        formatted_value = _format_business_value(key, value)
        if not formatted_value:
            continue

        rows_by_key[key] = (_format_resource_label(key), formatted_value)

    ordered_keys = [
        key for key in BUSINESS_FIELD_PRIORITY
        if key in rows_by_key
    ]
    ordered_keys.extend(
        key for key in rows_by_key
        if key not in ordered_keys
    )

    return [rows_by_key[key] for key in ordered_keys[:limit]]


def _business_resource_table(resource_json: dict, limit: int = 12) -> str:
    return _markdown_table(_business_resource_rows(resource_json, limit))


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

TRANSFER_RESOURCE_TYPES = {
    "transfer_order",
    "transfer_request",
    "transfer_instruction",
}

APPOINTMENT_RESOURCE_TYPES = {
    "appointment_request",
    "appointment_confirmation",
    "card_pickup_appointment",
}

COMPLAINT_RESOURCE_TYPES = {
    "complaint_document",
    "complaint_request",
    "transfer_dispute",
    "card_dispute",
    "card_dispute_report",
}


DIRECT_FACTUAL_RESOURCE_PATTERNS = [
    r"^\s*what\s+(?:is|are|was|does)\b",
    r"^\s*when\s+is\b",
    r"^\s*how\s+much\b",
    r"^\s*do\s+i\s+have\b",
    r"^\s*which\b",
    r"\bstatus\s+of\b",
    r"\brecommend\b",
    r"\bdue\b",
]

DOCUMENT_ORIENTED_TERMS = {
    "download",
    "fetch",
    "find",
    "form",
    "get",
    "guide",
    "show",
    "open",
    "policy",
    "profile",
    "product sheet",
    "view",
    "summarize",
    "summary",
    "statement",
    "certificate",
    "document",
    "notice",
    "receipt",
    "report",
    "sheet",
    "pdf",
}

DOWNLOAD_ELIGIBLE_RESOURCE_TYPES = {
    "account_closure_request",
    "account_statement",
    "rib_certificate",
    "account_certificate",
    "card_dispute_report",
    "card_dispute",
    "card_service_request",
    "checkbook_request",
    "cheque_book_request",
    "atm_receipt",
    "digital_banking_guide",
    "fx_receipt",
    "insurance_policy",
    "payment_receipt",
    "product_sheet",
    "security_notice",
    "tax_form",
    "salary_certificate",
    "transfer_order",
    "card_limit_notice",
    "customer_profile",
    "account_profile",
    "account_summary",
}

DOWNLOAD_EXCLUDED_RESOURCE_TYPES = {
    "loan_schedule",
    "fees_notice",
    "appointment_confirmation",
    "card_pickup_appointment",
    "kyc_summary",
}


def should_show_download_pdf(user_message: str, resource_type: str) -> bool:
    normalized_message = user_message.lower()
    normalized_resource_type = re.sub(
        r"[^a-z0-9]+",
        "_",
        str(resource_type or "").lower(),
    ).strip("_")

    if normalized_resource_type in {"atb_connect_guide", "digital_banking_guide"}:
        if _is_atb_connect_id_question(normalized_message):
            return False
        if _is_activation_how_to_request(normalized_message):
            return True

    is_document_oriented = any(term in normalized_message for term in DOCUMENT_ORIENTED_TERMS)

    is_direct_resource_question = any(
        re.search(pattern, normalized_message)
        for pattern in DIRECT_FACTUAL_RESOURCE_PATTERNS
    )
    has_open_document_verb = bool(
        re.search(r"\b(show|get|open|download|view|fetch|display)\b", normalized_message)
    )

    if is_direct_resource_question and not has_open_document_verb:
        return False

    if normalized_resource_type in DOWNLOAD_EXCLUDED_RESOURCE_TYPES:
        return False

    if not is_document_oriented:
        return False

    if normalized_resource_type in DOWNLOAD_ELIGIBLE_RESOURCE_TYPES:
        return True

    return is_document_oriented


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
    if not request.resolvedResourceContext:
        return {}

    resource_json = _resource_json(request)
    resource_type = _resource_type(request)

    if intent == "pay_bill":
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

    if intent == "make_transfer":
        if resource_type not in TRANSFER_RESOURCE_TYPES:
            return {}

        fields = {
            "sourceAccountId": _find_resource_value(
                resource_json,
                {"sourceAccountId", "accountId", "debitAccountId", "fromAccountId"},
            ),
            "beneficiaryId": _find_resource_value(resource_json, {"beneficiaryId"}),
            "beneficiaryName": _find_resource_value(resource_json, {"beneficiaryName", "beneficiary"}),
            "amount": _find_resource_value(resource_json, {"amount", "transferAmount", "totalAmount"}),
            "currency": _find_resource_value(resource_json, {"currency"}),
            "reason": _find_resource_value(resource_json, {"reason", "purpose", "memo"}),
        }
        return _clean_extracted_fields(fields)

    if intent == "book_appointment":
        if resource_type not in APPOINTMENT_RESOURCE_TYPES:
            return {}

        fields = {
            "branch": _find_resource_value(resource_json, {"branch", "agency"}),
            "date": _find_resource_value(resource_json, {"date", "appointmentDate"}),
            "time": _find_resource_value(resource_json, {"time", "appointmentTime", "slot"}),
        }
        return _clean_extracted_fields(fields)

    if intent == "create_complaint":
        if resource_type not in COMPLAINT_RESOURCE_TYPES:
            return {}

        category = _find_resource_value(resource_json, {"category", "complaintCategory", "issueType"})
        if not category and resource_type in {"card_dispute", "card_dispute_report"}:
            category = "Card issue"
        if not category and "transfer" in resource_type:
            category = "Failed transfer"

        description = _find_resource_value(resource_json, {"description", "details", "summary", "reason"})
        if not description:
            reference = _find_resource_value(resource_json, {"reference", "disputeId", "resourceId"})
            status = _find_resource_value(resource_json, {"status"})
            merchant = _find_resource_value(resource_json, {"merchant", "beneficiaryName", "beneficiary"})
            amount = _find_resource_value(resource_json, {"amount", "transferAmount", "totalAmount"})
            parts = [
                str(category or "Complaint issue"),
                f"reference {reference}" if reference else "",
                f"status {status}" if status else "",
                f"related to {merchant}" if merchant else "",
                f"for {_format_money(amount, _find_resource_value(resource_json, {'currency'}) or 'TND')}" if amount else "",
            ]
            description = " ".join(part for part in parts if part).strip()

        fields = {
            "category": category,
            "description": description,
            "sourceAccountId": _find_resource_value(resource_json, {"sourceAccountId", "accountId"}),
            "relatedReference": _find_resource_value(
                resource_json,
                {"reference", "transferReference", "transactionReference", "disputeId"},
            ),
            "amount": _find_resource_value(resource_json, {"amount", "transferAmount", "totalAmount"}),
            "currency": _find_resource_value(resource_json, {"currency"}),
        }
        return _clean_extracted_fields(fields)

    return {}


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


def _format_branch_rows(branches) -> str | None:
    if not isinstance(branches, list) or not branches:
        return None

    lines = ["| Branch | Address | Hours | Services |", "|---|---|---|---|"]
    for branch in branches[:12]:
        if isinstance(branch, dict):
            lines.append(
                f"| {branch.get('name') or branch.get('branch') or '-'} | "
                f"{branch.get('address') or '-'} | "
                f"{branch.get('hours') or branch.get('openingHours') or '-'} | "
                f"{branch.get('services') or branch.get('serviceList') or '-'} |"
            )
        else:
            lines.append(f"| {branch} | - | - | - |")
    return "\n".join(lines)


def _markdown_grid_table(headers: list[str], rows: list[list[object]]) -> str:
    usable_rows = [
        [str(cell or "").replace("\r\n", " ").replace("\n", " ").replace("|", "\\|").strip() or "-" for cell in row]
        for row in rows
        if any(str(cell or "").strip() for cell in row)
    ]
    if not headers or not usable_rows:
        return ""
    return "\n".join([
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
        *["| " + " | ".join(row) + " |" for row in usable_rows],
    ])


DEFAULT_TUNIS_BRANCH_ROWS = [
    ["Tunis Centre", "Avenue Habib Bourguiba", "08:30–16:30", "Accounts, cards, loans, appointments"],
    ["Ariana", "Rue de l’Indépendance", "08:30–16:30", "Accounts, ATM, transfers"],
    ["Lac 1", "Immeuble Business Center", "09:00–17:00", "Premium desk, SME support"],
    ["Menzah 6", "Avenue Othman Ibn Affan", "08:30–16:30", "Cards, deposits, account services"],
]


def _format_default_tunis_branch_table(resource_json: dict) -> str:
    if str(resource_json.get("region") or "").lower() != "tunis":
        return ""
    return _markdown_grid_table(
        ["Branch", "Address", "Hours", "Services"],
        DEFAULT_TUNIS_BRANCH_ROWS,
    )


def _extract_numbered_steps(text: str, start_label: str, end_labels: list[str] | None = None) -> list[str]:
    section = _extract_text_section(text, start_label, end_labels)
    if not section:
        return []

    steps: list[str] = []
    for line in section.splitlines():
        match = re.match(r"^\s*\d+\s+(.+?)\s*$", line)
        if match:
            steps.append(match.group(1).strip())
    return steps


def _generic_resource_table(resource_json: dict) -> str:
    return _business_resource_table(resource_json, limit=12)


def _extract_text_section(text: str, start_label: str, end_labels: list[str] | None = None) -> str:
    if not text:
        return ""
    normalized = text.replace("\r\n", "\n")
    start = normalized.lower().find(start_label.lower())
    if start < 0:
        return ""
    section = normalized[start:]
    for label in end_labels or []:
        end = section.lower().find(label.lower())
        if end > 0:
            section = section[:end]
            break
    return "\n".join(
        line.strip()
        for line in section.splitlines()
        if line.strip()
    ).strip()


def _build_resource_summary(request: AgentAnalyzeRequest, file_text: str, extracted_fields: dict) -> str | None:
    resource_json = _resource_json(request)
    resource_type = _resource_type(request)
    currency = resource_json.get("currency") or _extract_currency(file_text, extracted_fields)
    title = _resource_title(resource_json)

    if resource_type == "account_statement":
        return _build_resource_account_statement_summary(resource_json)

    if resource_type == "card_limit_notice":
        return _format_card_limit_notice(resource_json)

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

    if resource_type == "loan_offer":
        status = resource_json.get("status")
        max_amount = _resource_first_value(resource_json, "maxAmount", "maximumAmount", "amount")
        duration = _resource_first_value(resource_json, "duration", "term")
        rate = _resource_first_value(resource_json, "estimatedRate", "rate", "interestRate")
        monthly_payment = _resource_first_value(
            resource_json,
            "monthlyPaymentExample",
            "exampleMonthlyPayment",
            "monthlyPayment",
        )
        max_amount_display = _format_grouped_money(max_amount, currency) if max_amount else None
        monthly_payment_display = (
            _format_grouped_money(monthly_payment, currency)
            if monthly_payment
            else None
        )
        segment = _resource_first_value(resource_json, "customerSegment", "segment", "target")
        intro = f"The available student loan offer is the **{title}**."
        if segment and "student" not in str(title).lower():
            intro = f"The available loan offer for **{segment}** customers is **{title}**."

        sentences = []
        if status:
            sentences.append(f"You are {_bold_value(status)} for this offer.")
        if max_amount_display and duration:
            sentences.append(
                f"It supports a maximum amount of {_bold_value(max_amount_display)}, "
                f"with a duration from {_bold_value(duration)}."
            )
        elif max_amount_display:
            sentences.append(f"It supports a maximum amount of {_bold_value(max_amount_display)}.")
        elif duration:
            sentences.append(f"The duration is {_bold_value(duration)}.")
        if rate and monthly_payment_display:
            sentences.append(
                f"The estimated rate is {_bold_value(rate)}, and the example monthly "
                f"payment is {_bold_value(monthly_payment_display)}."
            )
        elif rate:
            sentences.append(f"The estimated rate is {_bold_value(rate)}.")
        elif monthly_payment_display:
            sentences.append(f"The example monthly payment is {_bold_value(monthly_payment_display)}.")

        body = " ".join(sentences) if sentences else _business_resource_bullets(resource_json)

        extra = _markdown_bullets([
            ("Offer reference", resource_json.get("offerId") or resource_json.get("reference")),
            ("Customer segment", segment),
        ])

        return "\n\n".join([
            f"## {title}",
            intro,
            body,
            extra,
        ]).strip()

    if resource_type == "card_dispute":
        return "\n\n".join([
            f"## {title}",
            _markdown_table([
                ("Dispute", resource_json.get("disputeId") or resource_json.get("reference")),
                ("Status", resource_json.get("status")),
                ("Merchant", resource_json.get("merchant")),
                ("Amount", _format_money(resource_json.get("amount"), currency)),
                ("Date", resource_json.get("date")),
            ]),
        ])

    if resource_type == "transfer_order":
        return "\n\n".join([
            f"## {title}",
            _markdown_table([
                ("Beneficiary", resource_json.get("beneficiaryName") or resource_json.get("beneficiaryId")),
                ("From account", resource_json.get("sourceAccountId")),
                ("Amount", _format_money(resource_json.get("amount"), currency)),
                ("Reason", resource_json.get("reason")),
            ]),
        ])

    if resource_type == "account_certificate":
        return "\n\n".join([
            f"## {title}",
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
            f"## {title}",
            _markdown_table([
                ("Name", resource_json.get("fullName")),
                ("Email", resource_json.get("email")),
                ("Phone", resource_json.get("phone")),
                ("Risk level", resource_json.get("riskLevel")),
                ("Last update", resource_json.get("lastUpdate")),
            ]),
        ])

    if resource_type in {"customer_profile", "account_profile", "account_summary"}:
        return _format_generic_resource_summary(resource_json, limit=8)

    if resource_type == "appointment_confirmation":
        return _format_appointment_resource(resource_json, resource_type)

    if resource_type == "card_pickup_appointment":
        return _format_appointment_resource(resource_json, resource_type)

    if resource_type in {"branch_directory", "branch_list"}:
        branch_table = _format_branch_rows(resource_json.get("branches") or resource_json.get("items"))
        default_branch_table = _format_default_tunis_branch_table(resource_json)
        return "\n\n".join([
            f"## {title}",
            branch_table or default_branch_table or _generic_resource_table(resource_json),
        ]).strip()

    if resource_type in {"atb_connect_guide", "digital_banking_guide"}:
        return _format_atb_connect_resource(request, resource_json, file_text)

    if resource_type in {"checkbook_request", "cheque_book_request"}:
        return _format_checkbook_request(resource_json)

    if resource_type == "card_service_request":
        return _format_card_service_request(resource_json)

    if resource_type == "atm_receipt":
        return _format_receipt_summary(resource_json, resource_type)

    if resource_type in {"payment_receipt", "fx_receipt"}:
        return _format_receipt_summary(resource_json, resource_type)

    if resource_type == "tax_form":
        return _format_tax_form(resource_json)

    if resource_type == "product_sheet":
        feature_values = [
            resource_json.get("features"),
            resource_json.get("benefits"),
            resource_json.get("services"),
        ]
        features = next((value for value in feature_values if isinstance(value, list) and value), [])
        includes = resource_json.get("includes")
        if not features and includes:
            features = [
                item.strip()
                for item in str(includes).split(",")
                if item.strip()
            ]
        feature_text = "\n".join(f"- {feature}" for feature in features[:8])
        product = resource_json.get("productName") or resource_json.get("title") or title
        target = resource_json.get("target")
        fee = resource_json.get("monthlyFee")
        status = resource_json.get("status")
        includes = resource_json.get("includes")
        summary_parts = [f"The product is **{product}**."]
        if target:
            summary_parts.append(f"It is intended for **{target}**.")
        if fee:
            summary_parts.append(f"The monthly fee is **{fee}**.")
        if status:
            summary_parts.append(f"Status: **{status}**.")
        if includes:
            summary_parts.append(f"It includes **{includes}**.")
        return "\n\n".join([
            f"## {resource_json.get('title') or 'Product Sheet'}",
            " ".join(summary_parts),
            feature_text,
        ]).strip()

    if resource_type in {"security_notice", "insurance_policy"}:
        return "\n\n".join([
            f"## {title}",
            resource_json.get("summary") or resource_json.get("description") or f"I found **{title}**.",
            _business_resource_bullets(resource_json),
        ]).strip()

    if resource_json:
        generic_summary = _format_generic_resource_summary(resource_json, limit=8)
        if generic_summary:
            return generic_summary

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

    if _is_account_details_request(request.message) and resource_type in {
        "account_statement",
        "account_certificate",
        "rib_certificate",
        "account_profile",
        "account_summary",
    }:
        balance = (
            resource_json.get("balance")
            if resource_json.get("balance") is not None
            else resource_json.get("closingBalance")
        )
        return "\n\n".join([
            "I found account details in your available resources.",
            _markdown_table([
                ("Account", resource_json.get("accountId")),
                ("Account number", resource_json.get("accountNumber")),
                ("Holder", resource_json.get("holder") or resource_json.get("customerName")),
                ("Type", resource_json.get("accountType") or resource_json.get("type")),
                ("Balance", _format_money(balance, currency) if balance is not None else None),
                ("Status", resource_json.get("status")),
                ("Branch", resource_json.get("branch")),
                ("Currency", resource_json.get("currency") or currency),
                ("Period", resource_json.get("period")),
            ]),
        ])

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

    if resource_type in {"atb_connect_guide", "digital_banking_guide"} and _is_atb_connect_id_question(request.message):
        required_id = resource_json.get("requiredId") or "not found"
        return f"For ATB Connect activation, you need **{required_id}**."

    if resource_type == "security_notice" and (
        "recommend" in normalized_message
        or "security" in normalized_message
        or "protect" in normalized_message
    ):
        recommendations = (
            resource_json.get("recommendations")
            or resource_json.get("tips")
            or resource_json.get("steps")
            or resource_json.get("actions")
        )
        if isinstance(recommendations, list) and recommendations:
            bullets = "\n".join(
                f"- {_bold_value(item)}"
                for item in recommendations[:6]
                if str(item).strip()
            )
            if bullets:
                return "\n\n".join([
                    "The mobile banking security notice recommends:",
                    bullets,
                ])
        summary = resource_json.get("summary") or resource_json.get("description")
        if summary:
            return f"The mobile banking security notice recommends: **{summary}**"

    if resource_type == "card_dispute" and ("status" in normalized_message or "dispute" in normalized_message):
        status = resource_json.get("status") or "not found"
        dispute_id = resource_json.get("disputeId") or resource_json.get("reference") or "not found"
        amount = _format_money(resource_json.get("amount"), resource_json.get("currency", "TND"))
        merchant = resource_json.get("merchant") or "not found"
        return f"Your card dispute **{dispute_id}** is **{status}**. It concerns {merchant} for {amount}."

    if resource_type == "card_service_request" and (
        "status" in normalized_message or "replacement" in normalized_message
    ):
        return _format_card_service_request(resource_json)

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

    if resource_type in {"appointment_confirmation", "card_pickup_appointment"} and (
        "appointment" in normalized_message or "branch" in normalized_message
    ):
        return _format_appointment_resource(resource_json, resource_type)

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
            direct_answer = _build_resource_direct_answer(request, file_text, extracted_fields)
            if direct_answer:
                return direct_answer
            resource_summary = _build_resource_summary(request, file_text, extracted_fields)
            if resource_summary:
                return resource_summary
            return (
                "I found the resource, but I could not extract readable text "
                "from the linked file."
            )
        return "I received the image, but I could not read enough text from it."

    if request.resolvedResourceContext:
        direct_answer = _build_resource_direct_answer(request, file_text, extracted_fields)
        if direct_answer:
            return direct_answer
        resource_summary = _build_resource_summary(request, file_text, extracted_fields)
        if resource_summary:
            return resource_summary

    if not file_text:
        return _build_unreadable_file_message(request, file_names)

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

    first_missing = missing_fields[0] if missing_fields else None

    if intent == "check_balance" and first_missing == "accountId":
        return "I can show your account details. Which account would you like to check?"

    if intent == "pay_bill" and first_missing == "provider":
        return "I can help prepare the bill payment. Which provider is it for?"

    if intent == "pay_bill" and first_missing == "sourceAccountId":
        return "I can help prepare the bill payment. Which account should I use?"

    if intent == "book_appointment" and first_missing == "branch":
        return "I can book an appointment for you. Which branch would you prefer?"

    if intent == "create_complaint" and first_missing == "category":
        return "I can prepare a complaint. What type of issue is it?"

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


def build_general_banking_answer(message: str) -> str | None:
    normalized = re.sub(r"\s+", " ", str(message or "").lower()).strip()

    if re.search(r"\bwhat\s+is\s+(?:a\s+|an\s+|the\s+)?loan\b", normalized):
        return (
            "A **loan** is money a bank or lender provides that you agree to repay over time. "
            "You usually repay the borrowed amount plus interest and any fees according to the loan contract."
        )

    if re.search(r"\bwhat\s+is\s+(?:a\s+|an\s+|the\s+)?rib\s+certificate\b", normalized):
        return (
            "A **RIB certificate** is a banking document that identifies a bank account. "
            "It usually contains the account holder name, bank details, branch or account "
            "information, and an account identifier such as a RIB or IBAN depending on the country."
        )

    if re.search(r"\bwhat\s+is\s+(?:a\s+|an\s+|the\s+)?current\s+account\b", normalized):
        return (
            "A **current account** is a day-to-day bank account used for regular money movement.\n\n"
            "- It is usually used to receive salary or business income.\n"
            "- It supports deposits, withdrawals, card payments, transfers, and bill payments.\n"
            "- It may include a cheque book, debit card, and online banking access depending on the bank package.\n"
            "- It is designed for frequent transactions rather than long-term saving."
        )

    if (
        "difference between" in normalized
        and "debit card" in normalized
        and "credit card" in normalized
    ):
        return (
            "A **debit card** spends money directly from your bank account, while a "
            "**credit card** lets you borrow up to an approved limit and repay later.\n\n"
            "| Card type | How it works | Main risk |\n"
            "|---|---|---|\n"
            "| Debit card | Uses your available account balance | Failed payment or overdraft if funds are insufficient |\n"
            "| Credit card | Uses a credit limit that you repay later | Interest, fees, and debt if not repaid on time |"
        )

    if re.search(r"\bhow\b.*\bcredit\s+card\b.*\bwork\b", normalized):
        return (
            "A **credit card** lets you spend up to an approved credit limit and repay the bank later. "
            "If you do not repay the full balance by the due date, interest and fees may apply."
        )

    if re.search(r"\blost\b.*\bcard\b|\bcard\b.*\blost\b", normalized):
        return (
            "If you lost your card, block it immediately in your banking app or by contacting the bank, then request a replacement. "
            "Review recent transactions and report any payment you do not recognize."
        )

    if re.search(r"\bavoid\b.*\b(mobile\s+banking\s+)?scams?\b|\bscams?\b.*\bmobile\s+banking\b", normalized):
        return (
            "To avoid mobile banking scams, never share OTP or SMS codes, use only the official bank app or website, avoid suspicious links, "
            "check payment details before confirming, and contact the bank quickly if something looks unusual."
        )

    if "interest rate" in normalized or "interest rates" in normalized:
        return (
            "An **interest rate** is the price of borrowing money or the return paid on savings. "
            "For a loan, a higher rate usually means higher monthly payments and a higher total repayment cost."
        )

    if (
        re.search(r"\bdocuments?\b.*\b(needed|required)\b.*\bloan\b", normalized)
        or re.search(r"\bloan\b.*\bdocuments?\b", normalized)
    ):
        return (
            "For a loan, banks usually ask for identification, proof of income, recent bank statements, employment or business details, "
            "and documents related to the loan purpose. The exact list depends on the bank, loan type, and applicant profile."
        )

    if "eligible" in normalized and "bank" in normalized:
        return (
            "Banks usually decide eligibility by reviewing income stability, existing debts, repayment history, account activity, requested amount, "
            "loan duration, and required documents. Final approval depends on the bank policy and risk checks."
        )

    if re.search(r"\bmiss\b.*\bbill\s+payment\b|\bbill\s+payment\b.*\bmiss\b", normalized):
        return (
            "If you miss a bill payment, the provider may charge a late fee, restrict the service, or mark the bill as overdue. "
            "Pay it as soon as possible and contact the provider or bank if you need help."
        )

    if re.search(r"\bprepare\b.*\bbank\s+appointment\b|\bbank\s+appointment\b.*\bprepare\b", normalized):
        return (
            "To prepare for a bank appointment, bring valid identification, relevant account or application references, proof of income if needed, "
            "and a short list of questions or documents you want reviewed."
        )

    if (
        "protect" in normalized
        and ("online banking" in normalized or "banking account" in normalized or "account" in normalized)
    ):
        return (
            "To protect your online banking account:\n\n"
            "1. Use a strong, unique password.\n"
            "2. Keep OTP or SMS codes private.\n"
            "3. Avoid logging in from shared or public devices.\n"
            "4. Check the website or app address before entering credentials.\n"
            "5. Enable alerts where available and report suspicious activity quickly."
        )

    return None


def _is_general_natural_chat_request(request: AgentAnalyzeRequest) -> bool:
    return bool(request.agentContext and request.agentContext.generalNaturalChat)


def _is_resource_response_writer_request(request: AgentAnalyzeRequest) -> bool:
    return bool(request.agentContext and request.agentContext.resourceResponseWriter)


def _is_generic_capabilities_response(value: str | None) -> bool:
    text = re.sub(r"\s+", " ", str(value or "").lower()).strip()
    return (
        "i can help with banking services" in text
        or "i can assist you with banking services" in text
    )


def _build_general_natural_chat_result(
    request: AgentAnalyzeRequest,
    assistant_message: str | None = None,
    *,
    source: str = "rule_based",
    confidence: float = 0.55,
) -> dict:
    fallback_answer = build_general_banking_answer(request.message)
    if (
        not _is_capabilities_question(request.message)
        and _is_generic_capabilities_response(assistant_message)
        and fallback_answer
    ):
        assistant_message = fallback_answer

    return {
        "source": source,
        "language": detect_language(request.message),
        "agentMode": "informational_answer",
        "intent": "general_natural_chat",
        "actionName": None,
        "documentTypeDetected": None,
        "confidence": confidence,
        "missingFields": [],
        "extractedFields": {},
        "requiredTool": "none",
        "toolInput": {
            "modelMode": "text",
            "resourceFound": False,
        },
        "assistantMessage": assistant_message
        or fallback_answer
        or (
            build_assistant_message("unknown", None)
            if _is_capabilities_question(request.message)
            else "Please ask the banking question a little more specifically so I can answer it directly."
        ),
    }


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

    if document_type == "scanned_or_image_document" and _has_uploaded_files(request):
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
        general_answer = build_general_banking_answer(request.message)
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
            "assistantMessage": general_answer or build_assistant_message(intent, action),
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
        "toolInput": _action_tool_input(request, intent, missing_fields),
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
        "toolInput": _action_tool_input(request, pending.actionName, missing_fields),
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
        "toolInput": _action_tool_input(request, intent, missing_fields),
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
    if _is_resource_response_writer_request(request):
        if settings.USE_OLLAMA:
            try:
                ollama_result = analyze_with_ollama(request)
                validated_result = _validate_ollama_result(ollama_result, request)
                return {
                    **validated_result,
                    "agentMode": "informational_answer",
                    "intent": "informational_answer",
                    "actionName": None,
                    "requiredTool": "none",
                }
            except (OllamaServiceError, ValueError, TypeError, KeyError):
                pass

        return analyze_uploaded_file(request)

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

    if _is_general_natural_chat_request(request):
        if settings.USE_OLLAMA:
            try:
                ollama_result = analyze_with_ollama(request)
                validated_result = _validate_ollama_result(ollama_result, request)
                return _build_general_natural_chat_result(
                    request,
                    validated_result.get("assistantMessage"),
                    source="ollama",
                    confidence=validated_result.get("confidence", 0.65),
                )
            except (OllamaServiceError, ValueError, TypeError, KeyError):
                pass

        return _build_general_natural_chat_result(request)

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
