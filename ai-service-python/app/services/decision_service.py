import re
from typing import Any

from app.config import settings
from app.schemas.agent import AgentAnalyzeRequest, AvailableAction
from app.services.field_extraction_service import extract_fields
from app.services.intent_service import (
    _clarification_quick_actions,
    build_general_banking_answer,
    calculate_missing_fields,
    detect_intent,
    find_available_action,
)
from app.services.ollama_service import OllamaServiceError, decide_with_ollama


VALID_DECISIONS = {
    "answer_directly",
    "search_resource",
    "prepare_action",
    "ask_clarification",
}

ACTION_INTENTS = {
    "check_balance",
    "generate_document",
    "create_complaint",
    "check_complaint_status",
    "book_appointment",
    "list_appointment_slots",
    "pay_bill",
    "make_transfer",
}

RESOURCE_OPTION_QUERIES = {
    "account statement": "account statement",
    "rib certificate": "RIB certificate",
    "receipt": "receipt",
    "appointment": "appointment",
    "complaint": "complaint",
    "branch directory": "branch directory",
    "credit card limit": "credit card limit",
    "card replacement": "debit card replacement request",
    "card dispute": "card dispute",
    "card pickup appointment": "card pickup appointment",
    "payment receipt": "payment receipt",
    "atm receipt": "ATM withdrawal receipt",
    "fx receipt": "foreign currency exchange receipt",
    "checkbook request": "checkbook request status",
    "beneficiary profile": "beneficiary profile Hiba Msallem",
    "saved beneficiary": "beneficiary profile Hiba Msallem",
}

BROAD_RESOURCE_CATEGORIES = {
    "account": ("acc_001", "account acc_001", "linked to acc_001"),
    "card": ("card", "cards", "debit card", "credit card"),
    "payments": ("payment", "payments", "bill", "bills", "receipt", "receipts"),
    "appointments": ("appointment", "appointments", "meeting", "meetings", "rendez-vous"),
    "documents": ("document", "documents", "form", "forms", "certificate", "certificates", "pdf"),
}


def _clean_fields(fields: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(fields, dict):
        return {}
    return {
        key: value
        for key, value in fields.items()
        if value is not None and not (isinstance(value, str) and value.strip() == "")
    }


def _normalize_text(value: str = "") -> str:
    return re.sub(r"\s+", " ", str(value or "").lower()).strip()


def _has_uploaded_files(request: AgentAnalyzeRequest) -> bool:
    return bool(
        request.fileContext
        and (
            request.fileContext.hasUploadedFiles
            or (request.fileContext.files and len(request.fileContext.files) > 0)
        )
    )


def _is_general_banking_question(message: str) -> bool:
    text = _normalize_text(message)
    if not text:
        return False

    if build_general_banking_answer(message):
        return True

    if (
        re.match(
            r"^what\s+(?:is|are)\s+(?:a\s+|an\s+|the\s+)?"
            r"(current account|savings? account|debit card|credit card|rib|iban|loan|overdraft)\b",
            text,
        )
        and not re.search(r"\b(my|mine|statement|receipt|document|status|balance|pdf)\b", text)
    ):
        return True

    return bool(
        "difference between" in text
        or re.match(r"^explain\b", text)
        or re.search(r"\bhow\s+(?:can\s+i|do\s+i|to)\s+protect\b", text)
    )


def _provider_from_message(message: str) -> str | None:
    text = _normalize_text(message)
    providers = {
        "sonede": "SONEDE",
        "steg": "STEG",
        "ooredoo": "OOREDOO",
        "orange": "ORANGE",
        "telecom": "TELECOM",
        "tunisie telecom": "TELECOM",
        "internet": "INTERNET",
    }
    for keyword, provider in providers.items():
        if keyword in text:
            return provider
    return None


def _is_appointment_booking_message(message: str) -> bool:
    text = _normalize_text(message)
    if not text:
        return False

    return bool(
        re.search(
            r"\b(book|schedule|reserve)\b.{0,40}\b(appointment|meeting|visit|rendez-vous)\b",
            text,
        )
        or re.search(
            r"\b(create|make)\b.{0,20}\b(an?\s+)?appointment\b",
            text,
        )
        or re.search(
            r"\b(appointment|meeting|visit|rendez-vous)\b.{0,40}\b(book|scheduled?|reserved?)\b",
            text,
        )
    )


def _is_appointment_lookup_message(message: str) -> bool:
    text = _normalize_text(message)
    if not text or _is_appointment_booking_message(message):
        return False

    appointment_terms = r"(appointment|meeting|visit|rendez-vous)"
    return bool(
        re.search(rf"^\s*do\s+i\s+have\b.*\b{appointment_terms}\b", text)
        or re.search(rf"\b{appointment_terms}\b.*\b(status|confirmed|confirmation|existing)\b", text)
        or re.search(rf"\b(status|confirmed|confirmation|existing)\b.*\b{appointment_terms}\b", text)
        or ("card pickup" in text and "appointment" in text)
        or ("branch appointment" in text and ("confirmed" in text or "have" in text))
    )


def _broad_resource_category(message: str) -> str | None:
    text = _normalize_text(message)
    if not text:
        return None

    has_search_verb = re.search(r"\b(find|show|list|search|get|look\s+for)\b", text)
    has_broad_scope = re.search(
        r"\b(anything|everything|all|linked|related|resources?|records?|files?)\b",
        text,
    )
    if re.search(r"\bacc\s*[_-]?\s*001\b", text) and has_broad_scope:
        return "account"
    if not has_search_verb or not has_broad_scope:
        return None

    if "card pickup" in text and re.search(r"\b(appointment|meeting|visit|rendez-vous)\b", text):
        return None

    for category, terms in BROAD_RESOURCE_CATEGORIES.items():
        if any(term in text for term in terms):
            return category

    return None


def _resource_query_for_message(message: str, intent: str) -> str:
    text = _normalize_text(message)
    provider = _provider_from_message(message)
    broad_category = _broad_resource_category(message)

    if broad_category:
        return broad_category

    if text in RESOURCE_OPTION_QUERIES:
        return RESOURCE_OPTION_QUERIES[text]

    if intent == "pay_bill" or provider:
        return f"{provider} bill" if provider else "bill"

    if "online purchase dispute" in text:
        return "online purchase dispute"

    if "saved beneficiary" in text or "beneficiary profile" in text or "hiba" in text:
        return "beneficiary profile Hiba Msallem"

    if _is_existing_transfer_resource_message(message):
        if "international" in text or "france" in text:
            return "international transfer request France"
        return "transfer request"

    if "standing order" in text or ("order" in text and "rent" in text):
        return "standing order rent"

    if "card pickup" in text and "appointment" in text:
        return "card pickup appointment"

    if "confirmed" in text and "branch" in text and "appointment" in text:
        return "confirmed branch appointment"

    if "branch" in text or "branches" in text:
        if "tunis" in text:
            return "branches Tunis"
        return "branch directory"

    if "card" in text and "limit" in text:
        return "credit card limit"

    if "atb connect" in text or ("connect" in text and "activate" in text):
        return "ATB Connect activation guide"

    if "mobile banking security" in text or ("security" in text and "notice" in text):
        return "mobile banking security notice"

    if "tax" in text or "self certification" in text or "self-certification" in text:
        return "tax residency self-certification form"

    if "salary" in text or "domiciliation" in text:
        return "salary domiciliation certificate"

    if "home insurance" in text or "insurance policy" in text:
        return "home insurance policy summary"

    if "account closure" in text or ("closure" in text and "request" in text):
        return "account closure request draft"

    if "student" in text and ("loan" in text or "credit" in text or "financing" in text):
        return "student loan offer"

    if "product sheet" in text or ("product" in text and "sheet" in text):
        return message.strip()

    if "atm" in text or ("withdrawal" in text and "receipt" in text):
        return "ATM withdrawal receipt"

    if (
        "foreign currency" in text
        or "currency exchange" in text
        or "foreign exchange" in text
        or "fx" in text.split()
        or ("exchange" in text and "receipt" in text)
    ):
        return "foreign currency exchange receipt"

    if "receipt" in text:
        return "receipt"

    if "statement" in text:
        return "account statement"

    if "rib" in text:
        return "RIB certificate"

    if "complaint" in text or "claim" in text:
        return "complaint"

    if "appointment" in text:
        return "appointment"

    return message.strip()


def _is_resource_lookup_message(message: str) -> bool:
    text = _normalize_text(message)
    if not text or _is_general_banking_question(message):
        return False

    if text in RESOURCE_OPTION_QUERIES:
        return True

    if _broad_resource_category(message):
        return True

    if _is_appointment_lookup_message(message):
        return True

    if _is_existing_transfer_resource_message(message):
        return True

    if "branch" in text or "branches" in text:
        return True

    if "card" in text and "limit" in text:
        return True

    if "atb connect" in text or ("connect" in text and "activate" in text):
        return True

    if "mobile banking security" in text or ("security" in text and "notice" in text):
        return True

    if "standing order" in text or ("order" in text and "rent" in text):
        return True

    if "home insurance" in text or "insurance policy" in text:
        return True

    if "account closure" in text or ("closure" in text and "request" in text):
        return True

    if "online purchase dispute" in text:
        return True

    if "saved beneficiary" in text or "beneficiary profile" in text or "hiba msallem" in text:
        return True

    if "student" in text and ("loan" in text or "credit" in text or "financing" in text):
        return True

    if "product sheet" in text or ("product" in text and "sheet" in text):
        return True

    if "atm" in text or ("withdrawal" in text and "receipt" in text):
        return True

    resource_nouns = (
        "limit",
        "loan",
        "offer",
        "product",
        "sheet",
        "pack",
        "receipt",
        "statement",
        "certificate",
        "document",
        "pdf",
        "notice",
        "request",
        "form",
        "guide",
        "directory",
        "insurance",
        "order",
        "policy",
        "resource",
        "resources",
        "standing",
        "checkbook",
        "chequebook",
        "profile",
        "kyc",
    )
    resource_verbs = (
        "show",
        "get",
        "open",
        "download",
        "view",
        "find",
        "fetch",
        "summarize",
        "summary",
        "available",
    )

    if any(noun in text for noun in resource_nouns) and any(
        verb in text for verb in resource_verbs
    ):
        return True

    return bool(
        re.search(r"\bstatus\b.*\b(request|complaint|dispute|replacement)\b", text)
        or re.search(r"\b(request|complaint|dispute|replacement)\b.*\bstatus\b", text)
    )


def _is_explicit_transfer_action_message(message: str) -> bool:
    text = _normalize_text(message)
    if not text:
        return False

    return bool(
        re.search(r"\b(make|create|initiate|start|send|execute|prepare|confirm)\b.{0,50}\b(transfer|money|funds)\b", text)
        or re.search(r"\btransfer\b.{0,30}\b(to|for)\b", text)
        and re.search(r"\b(send|make|execute|prepare|confirm)\b", text)
    )


def _is_existing_transfer_resource_message(message: str) -> bool:
    text = _normalize_text(message)
    if not text or _is_explicit_transfer_action_message(message):
        return False

    has_transfer_request = (
        "transfer request" in text
        or "international transfer" in text
        or ("transfer" in text and "request" in text)
    )
    asks_for_existing_details = bool(
        re.search(r"\b(what are|what is|show|view|get|give|display|find|check)\b.{0,60}\b(details?|status|information|summary)\b", text)
        or re.search(r"\b(details?|status|information|summary)\b.{0,60}\b(of|for|about)\b", text)
        or re.search(r"\bstatus\b.*\btransfer\b", text)
    )

    return has_transfer_request and asks_for_existing_details


def _is_receipt_lookup_message(message: str) -> bool:
    text = _normalize_text(message)
    return bool(
        "receipt" in text
        and re.search(r"\b(show|get|open|view|fetch|find|summarize)\b", text)
        and not re.search(r"\b(pay|settle|execute|confirm|proceed)\b", text)
    )


def _missing_fields_for_action(
    action_name: str | None,
    fields: dict[str, Any],
    available_actions: list[AvailableAction],
) -> list[str]:
    if not action_name:
        return []

    action = find_available_action(action_name, available_actions)
    if not action:
        return []

    return calculate_missing_fields(action, fields)


def _quick_actions_for_missing(action_name: str | None, missing_fields: list[str]) -> list[dict]:
    if not action_name or not missing_fields:
        return []
    return _clarification_quick_actions(action_name, missing_fields)


def _clarification_question(action_name: str | None, missing_fields: list[str]) -> str:
    first_missing = missing_fields[0] if missing_fields else None

    if action_name == "create_complaint" and first_missing == "category":
        return "I can prepare a complaint. What type of issue is it?"

    if action_name == "pay_bill" and first_missing == "provider":
        return "I can help prepare the bill payment. Which provider is it for?"

    if action_name == "pay_bill" and first_missing == "sourceAccountId":
        return "I can help prepare the bill payment. Which account should I use?"

    if action_name == "book_appointment" and first_missing == "branch":
        return "I can book an appointment for you. Which branch would you prefer?"

    if action_name == "check_balance" and first_missing == "accountId":
        return "I can show your account details. Which account would you like to check?"

    return "I need one more detail before I can continue. Which option should I use?"


def _decision(
    decision: str,
    intent: str,
    *,
    resource_query: str | None = None,
    action: str | None = None,
    fields: dict[str, Any] | None = None,
    missing_fields: list[str] | None = None,
    clarification_question: str | None = None,
    quick_actions: list[dict] | None = None,
) -> dict[str, Any]:
    return {
        "decision": decision,
        "intent": intent,
        "resourceQuery": resource_query,
        "action": action,
        "fields": _clean_fields(fields),
        "missingFields": missing_fields or [],
        "clarificationQuestion": clarification_question,
        "quickActions": quick_actions or [],
    }


def _rule_based_decision(request: AgentAnalyzeRequest) -> dict[str, Any]:
    message = request.message or ""

    if _has_uploaded_files(request):
        intent, _confidence = detect_intent(message)
        action_name = intent if intent in ACTION_INTENTS else None
        fields = extract_fields(action_name, message) if action_name else {}
        return _decision(
            "prepare_action" if action_name else "answer_directly",
            action_name or "uploaded_file_context",
            action=action_name,
            fields=fields,
            missing_fields=_missing_fields_for_action(
                action_name,
                fields,
                request.availableActions,
            ),
        )

    if _is_general_banking_question(message):
        return _decision("answer_directly", "general_banking_question")

    intent, _confidence = detect_intent(message)

    broad_category = _broad_resource_category(message)
    if broad_category:
        return _decision(
            "search_resource",
            "broad_resource_search",
            resource_query=broad_category,
            fields={},
        )

    if _is_appointment_lookup_message(message):
        return _decision(
            "search_resource",
            "appointment_lookup",
            resource_query=_resource_query_for_message(message, "appointment_lookup"),
            fields={},
        )

    if _is_receipt_lookup_message(message):
        return _decision(
            "search_resource",
            "resource_lookup",
            resource_query=message.strip(),
            fields={},
        )

    if intent == "pay_bill":
        fields = extract_fields(intent, message)
        provider = fields.get("provider") or _provider_from_message(message)
        has_bill_identity = bool(fields.get("billReference") and fields.get("amount"))

        if provider and not has_bill_identity:
            fields = _clean_fields({**fields, "provider": provider})
            return _decision(
                "search_resource",
                "pay_bill",
                resource_query=_resource_query_for_message(message, intent),
                action="pay_bill",
                fields=fields,
            )

        missing_fields = _missing_fields_for_action(
            "pay_bill",
            fields,
            request.availableActions,
        )
        if missing_fields and missing_fields[0] == "provider":
            return _decision(
                "ask_clarification",
                "pay_bill",
                action="pay_bill",
                fields=fields,
                missing_fields=missing_fields,
                clarification_question=_clarification_question("pay_bill", missing_fields),
                quick_actions=_quick_actions_for_missing("pay_bill", missing_fields),
            )

        return _decision(
            "prepare_action",
            "pay_bill",
            action="pay_bill",
            fields=fields,
            missing_fields=missing_fields,
        )

    if intent == "make_transfer" and (
        "saved beneficiary" in _normalize_text(message)
        or "beneficiary profile" in _normalize_text(message)
        or "hiba" in _normalize_text(message)
    ):
        fields = extract_fields("make_transfer", message)
        return _decision(
            "search_resource",
            "make_transfer",
            resource_query=_resource_query_for_message(message, "make_transfer"),
            action="make_transfer",
            fields=fields,
        )

    if intent == "create_complaint" and "online purchase dispute" in _normalize_text(message):
        fields = extract_fields("create_complaint", message)
        return _decision(
            "search_resource",
            "create_complaint",
            resource_query=_resource_query_for_message(message, "create_complaint"),
            action="create_complaint",
            fields=fields,
        )

    if intent == "book_appointment" and "card pickup" in _normalize_text(message):
        fields = extract_fields("book_appointment", message)
        return _decision(
            "search_resource",
            "book_appointment",
            resource_query=_resource_query_for_message(message, "book_appointment"),
            action="book_appointment",
            fields=fields,
        )

    if _is_resource_lookup_message(message):
        resource_intent = "branch_directory" if "branch" in _normalize_text(message) else "resource_lookup"
        return _decision(
            "search_resource",
            resource_intent,
            resource_query=_resource_query_for_message(message, resource_intent),
            fields={},
        )

    if intent in ACTION_INTENTS:
        action_name = intent
        fields = extract_fields(action_name, message)
        missing_fields = _missing_fields_for_action(
            action_name,
            fields,
            request.availableActions,
        )

        if action_name == "create_complaint" and missing_fields:
            return _decision(
                "ask_clarification",
                "create_complaint",
                action="create_complaint",
                fields=fields,
                missing_fields=missing_fields,
                clarification_question=_clarification_question(action_name, missing_fields),
                quick_actions=_quick_actions_for_missing(action_name, missing_fields),
            )

        return _decision(
            "prepare_action",
            action_name,
            action=action_name,
            fields=fields,
            missing_fields=missing_fields,
        )

    return _decision("answer_directly", "general_banking_question")


def _validate_model_decision(
    raw_result: dict[str, Any],
    request: AgentAnalyzeRequest,
    fallback: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(raw_result, dict):
        raise OllamaServiceError("Ollama decision must be an object")

    raw_decision = raw_result.get("decision")
    if raw_decision not in VALID_DECISIONS:
        raise OllamaServiceError("Ollama returned an invalid decision")

    # Deterministic guards preserve resource and safety behavior around known
    # resource lookups and action preparation.
    if fallback["decision"] in {"search_resource", "ask_clarification"}:
        return fallback

    if fallback["decision"] == "answer_directly" and _is_general_banking_question(request.message):
        return fallback

    if (
        fallback["decision"] == "prepare_action"
        and fallback.get("action") == "book_appointment"
        and _is_appointment_booking_message(request.message)
    ):
        return fallback

    intent = str(raw_result.get("intent") or fallback.get("intent") or "unknown")
    action_name = raw_result.get("action") or (
        intent if intent in ACTION_INTENTS else fallback.get("action")
    )

    if action_name and not find_available_action(action_name, request.availableActions):
        action_name = None

    fields = _clean_fields({
        **_clean_fields(raw_result.get("fields")),
        **_clean_fields(fallback.get("fields")),
    })
    if action_name:
        fields = _clean_fields({
            **fields,
            **extract_fields(action_name, request.message),
        })

    missing_fields = _missing_fields_for_action(
        action_name,
        fields,
        request.availableActions,
    )
    quick_actions = raw_result.get("quickActions")
    if not isinstance(quick_actions, list):
        quick_actions = []
    quick_actions = quick_actions or _quick_actions_for_missing(action_name, missing_fields)

    resource_query = raw_result.get("resourceQuery")
    if not isinstance(resource_query, str) or not resource_query.strip():
        resource_query = fallback.get("resourceQuery")

    clarification_question = raw_result.get("clarificationQuestion")
    if not isinstance(clarification_question, str) or not clarification_question.strip():
        clarification_question = None

    if raw_decision == "search_resource":
        return _decision(
            "search_resource",
            intent,
            resource_query=resource_query or _resource_query_for_message(request.message, intent),
            action=action_name,
            fields=fields,
            missing_fields=[],
            quick_actions=quick_actions,
        )

    if raw_decision == "ask_clarification":
        return _decision(
            "ask_clarification",
            intent,
            action=action_name,
            fields=fields,
            missing_fields=missing_fields or fallback.get("missingFields", []),
            clarification_question=clarification_question
            or _clarification_question(action_name, missing_fields),
            quick_actions=quick_actions,
        )

    if raw_decision == "prepare_action" and action_name:
        return _decision(
            "prepare_action",
            action_name,
            action=action_name,
            fields=fields,
            missing_fields=missing_fields,
            quick_actions=quick_actions,
        )

    return _decision("answer_directly", intent or "general_banking_question")


def decide_message(request: AgentAnalyzeRequest) -> dict[str, Any]:
    fallback = _rule_based_decision(request)

    if not settings.USE_OLLAMA:
        return fallback

    try:
        raw_result = decide_with_ollama(request)
        return _validate_model_decision(raw_result, request, fallback)
    except (OllamaServiceError, ValueError, TypeError, KeyError):
        return fallback
