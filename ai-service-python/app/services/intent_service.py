from app.schemas.agent import AgentAnalyzeRequest, AvailableAction
from app.config import settings
from app.services.field_extraction_service import extract_fields
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

# Web search requires strong explicit signals to avoid false positives
WEB_SEARCH_KEYWORDS = [
    "search the web",
    "search online",
    "search for",
    "find online",
    "look up online",
    "look it up",
    "web search",
    "internet search",
    "search internet",
    "find on internet",
    "latest news",
    "current news",
    "today's news",
    "chercher en ligne",
    "rechercher sur le web",
    "recherche sur internet",
    "ابحث على الإنترنت",
    "بحث في الإنترنت",
]

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
    "analyze_uploaded_file",
    "check_balance",
    "view_transactions",
    "generate_document",
    "create_complaint",
    "book_appointment",
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
    return bool(request.fileContext and request.fileContext.combinedText.strip())


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
    if not request.fileContext:
        return ""
    return request.fileContext.combinedText.strip()


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


def _is_web_search_request(message: str) -> bool:
    """User explicitly requests a live web search."""
    normalized = message.lower()
    return any(kw in normalized for kw in WEB_SEARCH_KEYWORDS)


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
# Intent / action helpers
# ---------------------------------------------------------------------------

def detect_intent(message: str) -> tuple[str, float]:
    normalized_message = message.lower()
    for intent, keywords in INTENT_KEYWORDS.items():
        if any(keyword in normalized_message for keyword in keywords):
            return intent, 0.85
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
    return [
        field for field in action.requiredFields if field not in extracted_fields
    ]


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
    "sourceAccountId": "Source account",
    "time": "Preferred time slot",
}


def _format_field_label(field: str) -> str:
    return FIELD_LABELS.get(field, field)


def _build_missing_fields_message(
    intro: str,
    missing_fields: list[str],
) -> str:
    fields = "\n".join(
        f"- {_format_field_label(field)}" for field in missing_fields
    )
    return (
        f"{intro}\n\n"
        f"**Required information**\n"
        f"{fields}\n\n"
        "Choose one of the options below or type your answer."
    )


def _build_file_summary_message(
    request: AgentAnalyzeRequest,
    extracted_fields: dict,
) -> str:
    file_text = _get_file_text(request)
    files = request.fileContext.files if request.fileContext else []
    file_names = ", ".join(file.originalName for file in files) or "the uploaded file"

    # Text extraction failed — tell the user clearly
    if not file_text:
        return (
            f"I received {file_names}, but I was not able to extract readable text "
            "from it. If it is a bill or document you would like to act on, please "
            "share the key details (reference number, provider, amount) in the chat."
        )

    if _looks_like_bill(file_text):
        provider = extracted_fields.get("provider")
        bill_ref = extracted_fields.get("billReference")
        amount = extracted_fields.get("amount")
        account = extracted_fields.get("sourceAccountId")

        lines = []
        lines.append(
            f"**Bill summary**\n\nI found a {provider} bill."
            if provider
            else f"**Bill summary**\n\nI found a bill in {file_names}."
        )

        if bill_ref:
            lines.append(f"- **Bill reference:** {bill_ref}")

        if amount is not None:
            if isinstance(amount, float) and not amount.is_integer():
                amount_str = f"{amount:.3f}"
            else:
                amount_str = str(int(amount)) if isinstance(amount, float) else str(amount)
            lines.append(f"- **Amount:** {amount_str} TND")

        if account:
            lines.append(f"- **Source account:** {account}")

        lines.append("\nI can help prepare the payment if you ask me to pay it.")
        return "\n".join(lines)

    preview = " ".join(file_text.split())
    if len(preview) > 420:
        preview = f"{preview[:420]}..."

    return (
        f"**File summary**\n\n"
        f"I read {file_names}. Here is a concise summary of the readable content:\n\n"
        f"- {preview}"
    )


def build_assistant_message(
    intent: str,
    action: AvailableAction | None,
    missing_fields: list[str] | None = None,
) -> str:
    if intent == "unknown" or action is None:
        return (
            "I'm here to help with your ATB banking needs.\n\n"
            "**I can assist with**\n"
            "- Balance inquiries\n"
            "- Transfers and bill payments\n"
            "- Document generation\n"
            "- Complaints and appointments\n\n"
            "What would you like to do?"
        )

    missing_fields = missing_fields or []

    if intent == "make_transfer":
        if "sourceAccountId" in missing_fields and "beneficiaryId" in missing_fields:
            return _build_missing_fields_message(
                "To prepare your transfer, I need a few details:",
                missing_fields,
            )
        if missing_fields:
            return _build_missing_fields_message(
                "To prepare your transfer, I need a few details:",
                missing_fields,
            )
        return "**Transfer request understood**\n\nI can help prepare this transfer."

    if intent == "pay_bill":
        if not missing_fields:
            return "**Bill payment request understood**\n\nI can help prepare this payment."
        return _build_missing_fields_message(
            "To prepare this bill payment, I need a few details:",
            missing_fields,
        )

    if missing_fields:
        intro_by_intent = {
            "book_appointment": "To book your appointment, I need a few details:",
            "generate_document": "To generate your document, I need a few details:",
            "create_complaint": "To create your complaint, I need a few details:",
            "check_balance": "To check your balance, I need one detail:",
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
    extracted_fields = extract_fields("pay_bill", file_text) if file_text else {}

    return {
        "source": "file_context",
        "language": language,
        "agentMode": "file_analysis",
        "intent": "analyze_uploaded_file",
        "actionName": None,
        "confidence": 0.9,
        "missingFields": [],
        "extractedFields": extracted_fields,
        "requiredTool": "none",
        "toolInput": {},
        "assistantMessage": _build_file_summary_message(request, extracted_fields),
    }


def analyze_web_search(request: AgentAnalyzeRequest) -> dict:
    """agentMode: web_search — backend will trigger web search connector."""
    language = detect_language(request.message)
    return {
        "source": "rule_based",
        "language": language,
        "agentMode": "web_search",
        "intent": "web_search",
        "actionName": None,
        "confidence": 0.9,
        "missingFields": [],
        "extractedFields": {},
        "requiredTool": "web_search",
        "toolInput": {"query": request.message},
        "assistantMessage": "Searching the web for relevant information...",
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
    file_text = request.fileContext.combinedText if request.fileContext else ""
    profile_text = _get_profile_text(request)
    analysis_text = f"{request.message}\n\n{file_text}\n\n{profile_text}".strip()
    intent, confidence = detect_intent(analysis_text)
    action = find_available_action(intent, request.availableActions)

    if intent == "unknown" or action is None:
        return {
            "source": "rule_based",
            "language": language,
            "agentMode": "informational_answer",
            "intent": "informational_answer",
            "actionName": None,
            "confidence": 0.3 if intent == "unknown" else 0.5,
            "missingFields": [],
            "extractedFields": {},
            "requiredTool": "none",
            "toolInput": {},
            "assistantMessage": build_assistant_message(intent, action),
        }

    extracted_fields = extract_fields(intent, analysis_text)
    missing_fields = calculate_missing_fields(action, extracted_fields)

    return {
        "source": "rule_based",
        "language": language,
        "agentMode": "banking_action",
        "intent": intent,
        "actionName": action.name,
        "confidence": confidence,
        "missingFields": missing_fields,
        "extractedFields": extracted_fields,
        "requiredTool": "connector_action",
        "toolInput": {},
        "assistantMessage": build_assistant_message(intent, action, missing_fields),
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


def _validate_ollama_result(
    raw_result: dict,
    request: AgentAnalyzeRequest,
) -> dict:
    language = raw_result.get("language", "unknown")
    intent = raw_result.get("intent", "unknown")
    action_name = raw_result.get("actionName")
    extracted_fields = raw_result.get("extractedFields", {})
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
            "confidence": _normalize_confidence(raw_result.get("confidence", 0.3)),
            "missingFields": [],
            "extractedFields": extracted_fields,
            "requiredTool": "none",
            "toolInput": {},
            "assistantMessage": assistant_message
            or build_assistant_message("unknown", None),
        }

    if action_name != intent:
        raise OllamaServiceError("Ollama actionName must match intent")

    action = find_available_action(action_name, request.availableActions)

    if action is None:
        raise OllamaServiceError("Ollama returned an unavailable action")

    file_text = request.fileContext.combinedText if request.fileContext else ""
    profile_text = _get_profile_text(request)
    analysis_text = f"{request.message}\n\n{file_text}\n\n{profile_text}".strip()
    extracted_fields = {
        **extract_fields(action_name, analysis_text),
        **extracted_fields,
    }
    missing_fields = calculate_missing_fields(action, extracted_fields)

    return {
        "source": "ollama",
        "language": language,
        "agentMode": "banking_action",
        "intent": intent,
        "actionName": action.name,
        "confidence": _normalize_confidence(raw_result.get("confidence", 0.5)),
        "missingFields": missing_fields,
        "extractedFields": extracted_fields,
        "requiredTool": "connector_action",
        "toolInput": {},
        "assistantMessage": assistant_message
        or build_assistant_message(intent, action, missing_fields),
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def analyze_message(request: AgentAnalyzeRequest) -> dict:
    """
    Classify the request into one of six agent modes and return structured data.

    Priority order:
      1. file_analysis     — uploaded file + analysis keywords
      2. web_search        — explicit web search keywords
      3. file_generation   — file export/generation keywords (non-banking)
      4. banking_action    — detected banking intent (Ollama or rule-based)
      5. informational_answer — default fallback
    """
    # 1. File analysis
    if _is_file_analysis_request(request):
        return analyze_uploaded_file(request)

    # 2. Web search
    if _is_web_search_request(request.message):
        return analyze_web_search(request)

    # 3. File generation (checked before banking to avoid Ollama interference)
    #    _is_file_generation_request already excludes banking document keywords
    if _is_file_generation_request(request.message):
        return analyze_file_generation(request)

    # 4. Banking intent detection (Ollama when enabled, rule-based fallback)
    if settings.USE_OLLAMA:
        try:
            ollama_result = analyze_with_ollama(request)
            validated_result = _validate_ollama_result(ollama_result, request)
            rule_based_result = analyze_message_rule_based(request)

            if (
                validated_result["agentMode"] == "informational_answer"
                and rule_based_result["agentMode"] == "banking_action"
            ):
                return rule_based_result

            return validated_result
        except (OllamaServiceError, ValueError, TypeError, KeyError):
            pass

    # 5. Rule-based banking / informational fallback
    return analyze_message_rule_based(request)
