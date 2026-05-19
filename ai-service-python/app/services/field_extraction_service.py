import re
from typing import Any


# Temporary rule-based extractor for the MVP.
# This will be replaced later by Ollama-based structured field extraction.
ACCOUNT_ID_PATTERN = re.compile(r"\bacc_\d+\b", re.IGNORECASE)
BILL_REFERENCE_PATTERN = re.compile(
    r"\b(?:STEG|SONEDE|OOREDOO)-\d{4}-\d{3}\b",
    re.IGNORECASE,
)
DATE_PATTERN = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
TIME_PATTERN = re.compile(r"\b\d{1,2}:\d{2}\b")
AMOUNT_PATTERN = re.compile(
    r"(?:\b(\d+(?:[.,]\d+)?)\s*(?:TND|DT|dinars?|د)\b)"
    r"|(?:\b(?:TND|DT|dinars?|د)\s*(\d+(?:[.,]\d+)?)\b)",
    re.IGNORECASE,
)

PROVIDERS = ["STEG", "SONEDE", "Ooredoo", "Orange", "Tunisie Telecom"]
DOCUMENT_TYPES = {
    "statement": ["statement", "releve", "relevé", "extrait"],
    "rib": ["rib"],
    "certificate": ["certificate", "attestation"],
}
COMPLAINT_CATEGORIES = ["transfer", "card", "payment", "account", "document"]
MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "janvier",
    "fevrier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "aout",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "decembre",
    "décembre",
]
PERIOD_PATTERN = re.compile(
    rf"\b({'|'.join(MONTHS)})\s+\d{{4}}\b",
    re.IGNORECASE,
)


def _normalize_amount(value: str) -> int | float:
    normalized = value.replace(",", ".")
    amount = float(normalized)

    if amount.is_integer():
        return int(amount)

    return amount


def _extract_account_id(message: str) -> str | None:
    match = ACCOUNT_ID_PATTERN.search(message)
    return match.group(0).lower() if match else None


def _extract_amount(message: str) -> int | float | None:
    match = AMOUNT_PATTERN.search(message)

    if not match:
        return None

    value = match.group(1) or match.group(2)
    return _normalize_amount(value)


def _extract_beneficiary_name(message: str) -> str | None:
    match = re.search(
        r"\b(?:to|a|à|vers)\s+([A-Z][a-zA-ZÀ-ÿ'-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'-]+)?)",
        message,
    )

    if match:
        return match.group(1).strip()

    arabic_match = re.search(r"(?:الى|إلى)\s+([\u0600-\u06ff\s]{2,30})", message)
    if arabic_match:
        return arabic_match.group(1).strip()

    return None


def _extract_provider(message: str) -> str | None:
    normalized = message.lower()

    for provider in PROVIDERS:
        if provider.lower() in normalized:
            return provider

    return None


def _extract_document_type(message: str) -> str | None:
    normalized = message.lower()

    for document_type, keywords in DOCUMENT_TYPES.items():
        if any(keyword in normalized for keyword in keywords):
            return document_type

    return None


def _extract_complaint_category(message: str) -> str | None:
    normalized = message.lower()

    for category in COMPLAINT_CATEGORIES:
        if category in normalized:
            return category

    return None


def _extract_branch(message: str) -> str | None:
    match = re.search(
        r"\b(?:at branch|branch|agency|agence)\s+([A-Za-zÀ-ÿ\s'-]{2,40})",
        message,
        re.IGNORECASE,
    )

    if not match:
        return None

    branch = match.group(1).strip()
    branch = re.split(r"\s+(?:on|at|le|à)\s+", branch, maxsplit=1)[0].strip()
    branch = re.sub(r"\s+(?:on|at|le|a|à)$", "", branch, flags=re.IGNORECASE)
    return branch or None


def extract_fields(intent: str, message: str) -> dict[str, Any]:
    fields: dict[str, Any] = {}

    if intent == "make_transfer":
        amount = _extract_amount(message)
        beneficiary_name = _extract_beneficiary_name(message)

        if amount is not None:
            fields["amount"] = amount
        if beneficiary_name:
            fields["beneficiaryName"] = beneficiary_name

    if intent == "pay_bill":
        bill_reference = BILL_REFERENCE_PATTERN.search(message)
        account_id = _extract_account_id(message)
        provider = _extract_provider(message)

        if bill_reference:
            fields["billReference"] = bill_reference.group(0).upper()
        if provider:
            fields["provider"] = provider
        if account_id:
            fields["sourceAccountId"] = account_id

    if intent == "generate_document":
        period = PERIOD_PATTERN.search(message)
        document_type = _extract_document_type(message)
        account_id = _extract_account_id(message)

        if period:
            fields["period"] = period.group(0)
        if document_type:
            fields["documentType"] = document_type
        if account_id:
            fields["accountId"] = account_id

    if intent == "create_complaint":
        category = _extract_complaint_category(message)

        if category:
            fields["category"] = category
        fields["description"] = message

    if intent == "book_appointment":
        branch = _extract_branch(message)
        date = DATE_PATTERN.search(message)
        time = TIME_PATTERN.search(message)

        if branch:
            fields["branch"] = branch
        if date:
            fields["date"] = date.group(0)
        if time:
            fields["time"] = time.group(0)

    return fields
