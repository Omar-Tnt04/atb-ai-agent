import re
from datetime import date, timedelta
from typing import Any


# Temporary rule-based extractor for the MVP.
# This will be replaced later by Ollama-based structured field extraction.
ACCOUNT_ID_PATTERN = re.compile(r"\bacc[\s_-]*\d+\b", re.IGNORECASE)
LABELED_ACCOUNT_ID_PATTERN = re.compile(
    r"\b(?:source|from)?\s*account\s*[:=-]?\s*(acc[\s_-]*\d+)\b",
    re.IGNORECASE,
)
BENEFICIARY_ID_PATTERN = re.compile(r"\bben_\d+\b", re.IGNORECASE)
BILL_REFERENCE_PATTERN = re.compile(
    r"\b(?:STEG|SONEDE|OOREDOO|TELECOM|ORANGE)-\d{4}-\d{3}\b",
    re.IGNORECASE,
)
COMPLAINT_REFERENCE_PATTERN = re.compile(
    r"\bCMP(?:-DEMO)?-\d{4}-\d{3,6}\b",
    re.IGNORECASE,
)
DATE_PATTERN = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
TIME_PATTERN = re.compile(r"\b\d{1,2}:\d{2}\b")
AMOUNT_PATTERN = re.compile(
    r"(?:\b(\d+(?:[.,]\d+)?)\s*(?:TND|DT|dinars?|د)\b)"
    r"|(?:\b(?:TND|DT|dinars?|د)\s*(\d+(?:[.,]\d+)?)\b)",
    re.IGNORECASE,
)

PROVIDERS = {
    "steg": "STEG",
    "sonede": "SONEDE",
    "ooredoo": "OOREDOO",
    "orange": "ORANGE",
    "tunisie telecom": "TELECOM",
    "telecom": "TELECOM",
    "tt": "TELECOM",
}
DOCUMENT_TYPES = {
    "statement": ["statement", "releve", "relevé", "extrait"],
    "RIB": ["rib"],
    "certificate": ["certificate", "attestation"],
}
FAILED_TRANSFER_DESCRIPTION = "A transfer failed and needs to be reviewed."
FAILED_TRANSFER_PATTERNS = [
    r"\bfailed\s+transfer\b",
    r"\btransfer\s+failed\b",
    r"\bfailed\s+transaction\b",
    r"\btransaction\s+failed\b",
    r"\btransfer\s+issue\b",
    r"\bamount\s+(?:was\s+)?deducted\b",
    r"\bdeducted\s+from\s+(?:my\s+)?account\b",
    r"\btransfer\b.{0,80}\bfailed\b",
    r"\bfailed\b.{0,80}\btransfer\b",
]
COMPLAINT_CATEGORY_RULES = [
    ("Failed transfer", FAILED_TRANSFER_PATTERNS),
    ("Card issue", [r"\bcard\s+(?:issue|problem|blocked|lost)\b", r"\bcard\b"]),
    (
        "Account access issue",
        [
            r"\baccount\s+access\b",
            r"\baccess\s+issue\b",
            r"\blogin\s+(?:issue|problem)\b",
            r"\baccount\b",
        ],
    ),
    (
        "Bill payment issue",
        [
            r"\bbill\s+payment\s+(?:issue|problem|failed)\b",
            r"\bpayment\s+(?:issue|problem|failed)\b",
            r"\bcharged\b",
            r"\bdebited\b",
            r"\bpayment\b",
        ],
    ),
    (
        "Document request issue",
        [
            r"\bdocument\s+(?:request\s+)?(?:issue|problem|failed)\b",
            r"\bstatement\s+(?:issue|problem|failed)\b",
        ],
    ),
]
COMPLAINT_CATEGORY_ONLY_PHRASES = {
    "failed transfer",
    "transfer failed",
    "failed transaction",
    "transaction failed",
    "transfer issue",
    "amount deducted",
    "card",
    "card issue",
    "account",
    "account access",
    "account access issue",
    "payment",
    "payment issue",
    "bill payment issue",
    "document",
    "document issue",
    "document request issue",
}
ACCOUNT_ALIASES = {
    "current account": "acc_001",
    "main account": "acc_001",
    "primary account": "acc_001",
    "checking account": "acc_001",
    "savings account": "acc_002",
    "saving account": "acc_002",
}
WEEKDAYS = {
    "monday": 0,
    "tuesday": 1,
    "wednesday": 2,
    "thursday": 3,
    "friday": 4,
    "saturday": 5,
    "sunday": 6,
}
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


def _normalize_account_id(value: str) -> str:
    match = re.search(r"acc[\s_-]*(\d+)", value, re.IGNORECASE)
    if not match:
        return value.lower()
    return f"acc_{match.group(1)}"


def _extract_account_id(message: str) -> str | None:
    labeled_match = LABELED_ACCOUNT_ID_PATTERN.search(message)
    if labeled_match:
        return _normalize_account_id(labeled_match.group(1))

    match = ACCOUNT_ID_PATTERN.search(message)
    if match:
        return _normalize_account_id(match.group(0))

    normalized = message.lower()
    for alias, account_id in ACCOUNT_ALIASES.items():
        if alias in normalized:
            return account_id

    return None


def _extract_amount(message: str) -> int | float | None:
    match = AMOUNT_PATTERN.search(message)

    if not match:
        labeled_amount = re.search(
            r"\b(?:total amount|amount|total|montant)[\"']?\s*[:=-]?\s*(\d+(?:[.,]\d+)?)\b",
            message,
            re.IGNORECASE,
        )
        if labeled_amount:
            return _normalize_amount(labeled_amount.group(1))

        fallback = re.search(
            r"\b(?:send|transfer|wire|pay)\s+(\d+(?:[.,]\d+)?)\b",
            message,
            re.IGNORECASE,
        )
        if not fallback:
            return None
        return _normalize_amount(fallback.group(1))

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

    for keyword, provider in PROVIDERS.items():
        if keyword in normalized:
            return provider

    return None


def _extract_document_type(message: str) -> str | None:
    normalized = message.lower()

    for document_type, keywords in DOCUMENT_TYPES.items():
        if any(keyword in normalized for keyword in keywords):
            return document_type

    return None


def _strip_chat_context(message: str) -> str:
    return re.split(
        r"\bcurrent request context\s*:",
        message,
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0].strip(" .\n\t")


def _primary_message_segment(message: str) -> str:
    return _strip_chat_context(message.split("\n\n", 1)[0])


def _strip_file_metadata(message: str) -> str:
    lines = []
    for line in _strip_chat_context(message).splitlines():
        stripped = line.strip()
        if re.match(r"^(file|mime)\s*:", stripped, re.IGNORECASE):
            continue
        if stripped == "---":
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def _complaint_extraction_text(message: str) -> str:
    document_text = _strip_file_metadata(message)

    if "\n" in document_text or "File:" in message or "MIME:" in message:
        return document_text

    return _primary_message_segment(message)


def _matches_any(normalized: str, patterns: list[str]) -> bool:
    return any(re.search(pattern, normalized, re.IGNORECASE) for pattern in patterns)


def _extract_complaint_category(message: str) -> str | None:
    normalized = message.lower()

    labeled_category = re.search(
        r"\b(?:complaint\s+)?category\s*[:=-]\s*([^\n\r:=-]{2,60})",
        message,
        re.IGNORECASE,
    )
    if labeled_category:
        category_text = labeled_category.group(1).strip()
        for category, patterns in COMPLAINT_CATEGORY_RULES:
            if _matches_any(category_text.lower(), patterns):
                return category
        return category_text[:1].upper() + category_text[1:]

    for category, patterns in COMPLAINT_CATEGORY_RULES:
        if _matches_any(normalized, patterns):
            return category

    return None


def _clean_description(value: str) -> str | None:
    description = re.sub(r"\s+", " ", value).strip(" .:-")
    if not description:
        return None

    normalized = re.sub(
        r"^(?:a|an|the)\s+",
        "",
        description.lower(),
        flags=re.IGNORECASE,
    )

    if normalized in COMPLAINT_CATEGORY_ONLY_PHRASES:
        return None

    return description[:1].upper() + description[1:]


def _extract_explicit_complaint_description(message: str) -> str | None:
    sanitized = _complaint_extraction_text(message)

    labeled_description = re.search(
        r"\b(?:problem\s+description|description|details?)\s*[:=-]\s*(.+?)(?:\n[A-Za-z ]{2,30}\s*[:=-]|\Z)",
        sanitized,
        re.IGNORECASE | re.DOTALL,
    )
    if labeled_description:
        description = _clean_description(labeled_description.group(1))
        if description and len(description.split()) >= 3:
            return description

    detail_match = re.search(
        r"\b(?:because|since|that|where|when)\s+(.+)$",
        sanitized,
        re.IGNORECASE,
    )
    if detail_match:
        description = _clean_description(detail_match.group(1))
        if description and len(description.split()) >= 4:
            return description

    colon_match = re.search(r"\bcomplaint\s*[:\-]\s*(.+)$", sanitized, re.IGNORECASE)
    if colon_match:
        description = _clean_description(colon_match.group(1))
        if description and len(description.split()) >= 4:
            return description

    without_intro = re.sub(
        r"^\s*(?:please\s+)?(?:create|open|submit|file|raise|make)?\s*"
        r"(?:a\s+)?complaint(?:\s+(?:about|for|regarding|on))?\s*",
        "",
        sanitized,
        flags=re.IGNORECASE,
    )
    description = _clean_description(without_intro)

    if "\n" in sanitized:
        return None

    if description and len(description.split()) >= 4:
        return description

    return None


def _split_sentences(message: str) -> list[str]:
    cleaned = _strip_file_metadata(message)
    if not cleaned.strip():
        return []

    sentences: list[str] = []
    for line in cleaned.splitlines():
        compact_line = re.sub(r"\s+", " ", line).strip()
        if not compact_line:
            continue
        sentences.extend(
            sentence.strip(" .:-")
            for sentence in re.split(r"(?<=[.!?])\s+", compact_line)
            if sentence.strip(" .:-")
        )

    return sentences


def _extract_failed_transfer_sentence(message: str) -> str | None:
    for sentence in _split_sentences(message):
        normalized_sentence = sentence.lower()
        if _matches_any(normalized_sentence, FAILED_TRANSFER_PATTERNS):
            description = _clean_description(sentence)
            if description and len(description.split()) >= 4:
                return description

    return None


def _extract_related_reference(message: str) -> str | None:
    transfer_reference = re.search(
        r"\bTRF(?:-DEMO)?-\d{4}-\d{3,6}\b",
        message,
        re.IGNORECASE,
    )
    if transfer_reference:
        return transfer_reference.group(0).upper()

    labeled_reference = re.search(
        r"\b(?:transaction|transfer|operation)\s+(?:id|reference|ref)\s*[:=-]\s*([A-Z0-9][A-Z0-9-]{3,})",
        message,
        re.IGNORECASE,
    )
    if labeled_reference:
        return labeled_reference.group(1).upper()

    return None


def _build_failed_transfer_description(message: str) -> str:
    normalized = message.lower()
    beneficiary = BENEFICIARY_ID_PATTERN.search(message)
    account = _extract_account_id(message)
    amount = _extract_amount(message)
    reference = _extract_related_reference(message)

    details: list[str] = []
    if amount is not None:
        details.append(f"for {amount} TND")
    if beneficiary:
        details.append(f"to {beneficiary.group(0).lower()}")
    if account:
        details.append(f"from {account}")
    if reference:
        details.append(f"reference {reference}")

    transfer_detail = f" {' '.join(details)}" if details else ""

    if "charged" in normalized or "debited" in normalized or "deducted" in normalized:
        return (
            f"Transfer{transfer_detail} failed and the user says the amount "
            "may have been deducted."
        )

    if "complain" in normalized or "complaint" in normalized:
        return f"Transfer{transfer_detail} failed and the user wants to submit a complaint."

    return FAILED_TRANSFER_DESCRIPTION


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


def _extract_date(message: str) -> str | None:
    explicit_date = DATE_PATTERN.search(message)
    if explicit_date:
        return explicit_date.group(0)

    normalized = message.lower()
    today = date.today()

    if "tomorrow" in normalized:
        return (today + timedelta(days=1)).isoformat()

    for weekday, weekday_index in WEEKDAYS.items():
        if re.search(rf"\b(?:next\s+)?{weekday}\b", normalized):
            days_ahead = (weekday_index - today.weekday()) % 7
            if days_ahead == 0:
                days_ahead += 7
            return (today + timedelta(days=days_ahead)).isoformat()

    return None


def _extract_time(message: str) -> str | None:
    explicit_time = TIME_PATTERN.search(message)
    if explicit_time:
        return explicit_time.group(0)

    return None


def _extract_due_date(message: str) -> str | None:
    match = re.search(
        r"\b(?:due date|due|pay by|deadline)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2})\b",
        message,
        re.IGNORECASE,
    )
    if match:
        return match.group(1)

    return None


def _extract_branch(message: str) -> str | None:
    patterns = [
        r"\b(?:branch|agency|agence)\s*[:=-]\s*([^\n:=-]{2,40})",
        r"\b(?:at|visit|in)\s+(?:the\s+)?([A-Za-zÀ-ÿ\s'-]{2,40})\s+branch\b",
        r"\b(?:at branch|branch|agency|agence)\s+([A-Za-zÀ-ÿ\s'-]{2,40})",
        r"\bappointment\s+at\s+([A-Za-zÀ-ÿ\s'-]{2,40})",
    ]

    for pattern in patterns:
        match = re.search(pattern, message, re.IGNORECASE)
        if not match:
            continue

        branch = match.group(1).strip()
        branch = re.split(
            r"\s+(?:tomorrow|today|next|on|at|le|a|à|morning|afternoon|evening)\b",
            branch,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0].strip()
        branch = re.sub(r"\s+(?:on|at|le|a|à)$", "", branch, flags=re.IGNORECASE)
        return branch or None

    return None


def extract_fields(intent: str, message: str) -> dict[str, Any]:
    fields: dict[str, Any] = {}

    if intent == "check_balance":
        account_id = _extract_account_id(message)

        if account_id:
            fields["accountId"] = account_id

    if intent == "make_transfer":
        amount = _extract_amount(message)
        beneficiary_name = _extract_beneficiary_name(message)
        beneficiary_id = BENEFICIARY_ID_PATTERN.search(message)
        account_id = _extract_account_id(message)

        if amount is not None:
            fields["amount"] = amount
            fields["currency"] = "TND"
        if beneficiary_name:
            fields["beneficiaryName"] = beneficiary_name
        if beneficiary_id:
            fields["beneficiaryId"] = beneficiary_id.group(0).lower()
        if account_id:
            fields["sourceAccountId"] = account_id

    if intent == "pay_bill":
        bill_reference = BILL_REFERENCE_PATTERN.search(message)
        account_id = _extract_account_id(message)
        provider = _extract_provider(message)
        amount = _extract_amount(message)
        due_date = _extract_due_date(message)

        if bill_reference:
            fields["billReference"] = bill_reference.group(0).upper()
        if provider:
            fields["provider"] = provider
        if account_id:
            fields["sourceAccountId"] = account_id
        if amount is not None:
            fields["amount"] = amount
            fields["currency"] = "TND"
        if due_date:
            fields["dueDate"] = due_date

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

    if intent == "check_complaint_status":
        reference = COMPLAINT_REFERENCE_PATTERN.search(message)

        if reference:
            fields["reference"] = reference.group(0).upper()

    if intent == "create_complaint":
        complaint_message = _complaint_extraction_text(message)
        category = _extract_complaint_category(complaint_message)
        description = (
            _extract_explicit_complaint_description(complaint_message)
            or _extract_failed_transfer_sentence(complaint_message)
        )
        account_id = _extract_account_id(complaint_message)
        amount = _extract_amount(complaint_message)
        beneficiary_id = BENEFICIARY_ID_PATTERN.search(complaint_message)
        related_reference = _extract_related_reference(complaint_message)

        if category:
            fields["category"] = category
        if category == "Failed transfer":
            fields["description"] = description or _build_failed_transfer_description(complaint_message)
        elif description:
            fields["description"] = description
        if account_id:
            fields["sourceAccountId"] = account_id
        if amount is not None:
            fields["amount"] = amount
            fields["currency"] = "TND"
        if beneficiary_id:
            fields["beneficiaryId"] = beneficiary_id.group(0).lower()
        if related_reference:
            fields["relatedReference"] = related_reference

    if intent == "book_appointment":
        branch = _extract_branch(message)
        appointment_date = _extract_date(message)
        time = _extract_time(message)

        if branch:
            fields["branch"] = branch
        if appointment_date:
            fields["date"] = appointment_date
        if time:
            fields["time"] = time

    return fields
