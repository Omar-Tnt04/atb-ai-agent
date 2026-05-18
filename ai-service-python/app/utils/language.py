ARABIC_KEYWORDS = ["رصيد", "فاتورة", "تحويل", "موعد", "شكوى", "حساب"]
FRENCH_KEYWORDS = [
    "bonjour",
    "solde",
    "facture",
    "virement",
    "rendez-vous",
    "reclamation",
    "réclamation",
    "agence",
]


def contains_arabic_characters(text: str) -> bool:
    return any("\u0600" <= character <= "\u06ff" for character in text)


def detect_language(message: str) -> str:
    normalized_message = message.lower()

    if contains_arabic_characters(message) or any(
        keyword in normalized_message for keyword in ARABIC_KEYWORDS
    ):
        return "arabic"

    if any(keyword in normalized_message for keyword in FRENCH_KEYWORDS):
        return "french"

    return "english"
