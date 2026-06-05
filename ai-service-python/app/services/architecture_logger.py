import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.config import settings


SENSITIVE_KEY_PATTERN = re.compile(
    r"(password|passwd|token|jwt|authorization|secret|sms|otp|code|rib|iban|"
    r"accountnumber|account_number|cardnumber|card_number|pdfbase64|imagebase64|base64|prompt|"
    r"privatecontext|filetext|fulltext|rawoutput|rawresponse|responsebody)",
    re.IGNORECASE,
)

LARGE_CONTEXT_KEY_PATTERN = re.compile(
    r"(resourcejson|resourcecontext|resolvedresourcecontext|matchedresource|matchedresources|"
    r"resources|filecontext|conversationhistory|privatecontext)",
    re.IGNORECASE,
)

TEXT_LENGTH_ONLY_KEY_PATTERN = re.compile(
    r"(message|query|goal|reason|assistant|response)(?!_?preview)",
    re.IGNORECASE,
)

MAX_STRING_LENGTH = 160
MAX_PREVIEW_LENGTH = 120


def _log_dir() -> Path:
    configured = Path(settings.LOG_DIR)
    if configured.is_absolute():
        return configured
    return (Path(__file__).resolve().parents[3] / configured).resolve()


LOG_DIR = _log_dir()
ARCHITECTURE_LOG = LOG_DIR / "architecture.log"
ARCHITECTURE_JSONL = LOG_DIR / "architecture.jsonl"
ERRORS_LOG = LOG_DIR / "errors.log"


def _enabled() -> bool:
    return bool(settings.ARCHITECTURE_LOGS_ENABLED)


def _truncate(value: Any, limit: int = MAX_STRING_LENGTH) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    text = re.sub(r"\s+", " ", text)
    return f"{text[:limit]}..." if len(text) > limit else text


def _mask_identifier(value: Any) -> str:
    text = re.sub(r"\s+", "", str(value or ""))
    if len(text) <= 4:
        return "****"
    return f"{'*' * min(8, max(4, len(text) - 4))}{text[-4:]}"


def _compact_object_summary(payload: Any) -> Any:
    if not isinstance(payload, (dict, list)):
        return payload
    if isinstance(payload, list):
        return {
            "itemCount": len(payload),
            "itemTypes": [type(item).__name__ for item in payload[:5]],
        }

    return {
        "keys": list(payload.keys())[:20],
        "title": payload.get("title") or payload.get("name") or payload.get("fileName"),
        "resourceId": payload.get("resourceId") or payload.get("id"),
        "resourceType": payload.get("resourceType") or payload.get("type"),
        "contentType": payload.get("contentType") or payload.get("mimeType"),
        "extractionStatus": payload.get("extractionStatus"),
        "fileSize": payload.get("fileSize") or payload.get("size"),
        "hasPdfPayload": bool(payload.get("pdfBase64")),
        "hasFileText": bool(payload.get("fileText")),
    }


def maskLogPayload(payload: Any, key: str = "") -> Any:
    if payload is None:
        return None
    if LARGE_CONTEXT_KEY_PATTERN.search(str(key or "")):
        return _compact_object_summary(payload)
    if isinstance(payload, list):
        return [maskLogPayload(item, key) for item in payload[:12]]
    if isinstance(payload, dict):
        return {item_key: maskLogPayload(item_value, item_key) for item_key, item_value in payload.items()}

    if SENSITIVE_KEY_PATTERN.search(str(key or "")):
        if re.search(r"account|card|rib|iban", str(key or ""), re.IGNORECASE):
            return _mask_identifier(payload)
        if re.search(r"base64", str(key or ""), re.IGNORECASE):
            return f"[base64 length={len(str(payload or ''))}]"
        return "[redacted]"

    text = str(payload)
    if TEXT_LENGTH_ONLY_KEY_PATTERN.search(str(key or "")):
        return f"[text length={len(text)}]"
    if re.match(r"^Bearer\s+", text, re.IGNORECASE):
        return "[redacted bearer token]"
    if re.match(r"^[A-Za-z0-9+/=]{500,}$", text):
        return f"[large base64-like value length={len(text)}]"
    return _truncate(text)


def _write(path: Path, line: str) -> None:
    if not _enabled():
        return
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{line}\n")
    except Exception:
        print("[architecture-logger] write failed", flush=True)


def logArchitecture(eventName: str, payload: dict[str, Any] | None = None, level: str = "info") -> None:
    if not _enabled():
        return
    data = maskLogPayload(payload or {})
    timestamp = datetime.now(timezone.utc).isoformat()
    request_id = data.get("requestId") or "no-request-id"
    message = data.get("message") or eventName
    record = {
        "timestamp": timestamp,
        "level": level,
        "requestId": request_id,
        "stage": eventName,
        "message": message,
        "data": data,
    }
    _write(ARCHITECTURE_JSONL, json.dumps(record, ensure_ascii=False))
    fields = " ".join(
        f"{key}={json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value}"
        for key, value in data.items()
        if key not in {"requestId", "message"}
    )
    _write(ARCHITECTURE_LOG, f"[{timestamp}] [{request_id}] [{eventName}] {message}{(' | ' + fields) if fields else ''}")


def logError(eventName: str, error: Exception, payload: dict[str, Any] | None = None) -> None:
    data = {
        **(payload or {}),
        "errorType": error.__class__.__name__,
        "errorMessage": str(error),
    }
    logArchitecture(eventName, data, level="error")
    _write(ERRORS_LOG, json.dumps({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": "error",
        "stage": eventName,
        "data": maskLogPayload(data),
    }, ensure_ascii=False))


def startTimer(label: str | None = None) -> float:
    return time.perf_counter()


def endTimer(started_at: float) -> int:
    return max(0, round((time.perf_counter() - started_at) * 1000))


def message_preview(value: Any, limit: int = MAX_PREVIEW_LENGTH) -> str:
    return f"[text length={len(str(value or ''))}]"
