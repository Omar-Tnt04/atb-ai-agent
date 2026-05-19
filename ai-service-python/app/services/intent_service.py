from app.schemas.agent import AgentAnalyzeRequest, AvailableAction
from app.services.field_extraction_service import extract_fields
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


def analyze_message(request: AgentAnalyzeRequest) -> dict:
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
            "assistantMessage": build_assistant_message(intent, action),
        }

    extracted_fields = extract_fields(intent, request.message)
    missing_fields = [
        field for field in action.requiredFields if field not in extracted_fields
    ]

    return {
        "language": language,
        "intent": intent,
        "actionName": action.name,
        "confidence": confidence,
        "missingFields": missing_fields,
        "extractedFields": extracted_fields,
        "assistantMessage": build_assistant_message(intent, action, missing_fields),
    }
