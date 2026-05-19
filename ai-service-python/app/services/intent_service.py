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
        "document",
        "statement",
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
        "pay bill",
        "bill",
        "invoice",
        "steg",
        "sonede",
        "ooredoo",
        "payer facture",
        "facture",
        "فاتورة",
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

VALID_LANGUAGES = {"english", "french", "arabic", "unknown"}
VALID_INTENTS = {
    "check_balance",
    "view_transactions",
    "generate_document",
    "create_complaint",
    "book_appointment",
    "pay_bill",
    "make_transfer",
    "unknown",
}


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


def build_assistant_message(
    intent: str,
    action: AvailableAction | None,
    missing_fields: list[str] | None = None,
) -> str:
    if intent == "unknown" or action is None:
        return (
            "I understood your message, but I could not identify a connected "
            "banking action yet."
        )

    missing_fields = missing_fields or []

    if intent == "make_transfer":
        if "sourceAccountId" in missing_fields and "beneficiaryId" in missing_fields:
            return (
                "I can assist you with this transfer. Please select the source "
                "account and beneficiary."
            )
        if missing_fields:
            fields = ", ".join(missing_fields)
            return f"I can assist you with this transfer. Please provide: {fields}."
        return "I can assist you with this transfer."

    if intent == "pay_bill":
        if not missing_fields:
            return "I can assist you with this bill payment."
        return (
            "I can assist you with this bill payment. Please provide the bill "
            "reference and select the source account."
        )

    if missing_fields:
        fields = ", ".join(missing_fields)
        return (
            f"I can assist you with this banking action. Please provide: "
            f"{fields}."
        )

    return "I can assist you with this banking action."


def analyze_message_rule_based(request: AgentAnalyzeRequest) -> dict:
    language = detect_language(request.message)
    intent, confidence = detect_intent(request.message)
    action = find_available_action(intent, request.availableActions)

    if intent == "unknown" or action is None:
        return {
            "language": language,
            "intent": "unknown" if intent == "unknown" else intent,
            "actionName": None,
            "confidence": 0.3 if intent == "unknown" else 0.5,
            "missingFields": [],
            "extractedFields": {},
            "source": "rule_based",
            "assistantMessage": build_assistant_message(intent, action),
        }

    extracted_fields = extract_fields(intent, request.message)
    missing_fields = calculate_missing_fields(action, extracted_fields)

    return {
        "source": "rule_based",
        "language": language,
        "intent": intent,
        "actionName": action.name,
        "confidence": confidence,
        "missingFields": missing_fields,
        "extractedFields": extracted_fields,
        "assistantMessage": build_assistant_message(intent, action, missing_fields),
    }


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

    if intent == "unknown" or action_name is None:
        return {
            "source": "ollama",
            "language": language,
            "intent": "unknown",
            "actionName": None,
            "confidence": _normalize_confidence(raw_result.get("confidence", 0.3)),
            "missingFields": [],
            "extractedFields": extracted_fields,
            "assistantMessage": assistant_message
            or build_assistant_message("unknown", None),
        }

    if action_name != intent:
        raise OllamaServiceError("Ollama actionName must match intent")

    action = find_available_action(action_name, request.availableActions)

    if action is None:
        raise OllamaServiceError("Ollama returned an unavailable action")

    missing_fields = calculate_missing_fields(action, extracted_fields)

    return {
        "source": "ollama",
        "language": language,
        "intent": intent,
        "actionName": action.name,
        "confidence": _normalize_confidence(raw_result.get("confidence", 0.5)),
        "missingFields": missing_fields,
        "extractedFields": extracted_fields,
        "assistantMessage": assistant_message
        or build_assistant_message(intent, action, missing_fields),
    }


def analyze_message(request: AgentAnalyzeRequest) -> dict:
    if not settings.USE_OLLAMA:
        return analyze_message_rule_based(request)

    try:
        ollama_result = analyze_with_ollama(request)
        return _validate_ollama_result(ollama_result, request)
    except (OllamaServiceError, ValueError, TypeError, KeyError):
        return analyze_message_rule_based(request)
