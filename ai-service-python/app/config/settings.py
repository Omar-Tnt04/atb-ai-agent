import os

from dotenv import load_dotenv


load_dotenv()

from app.config import model_routing  # noqa: E402


def _get_bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)

    if value is None:
        return default

    return value.strip().lower() in {"1", "true", "yes", "on"}


OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
MODEL_ROUTING_MODE = model_routing.MODEL_ROUTING_MODE
OLLAMA_TEXT_MODEL = model_routing.OLLAMA_TEXT_MODEL
OLLAMA_TEXT_KEEP_ALIVE = model_routing.OLLAMA_TEXT_KEEP_ALIVE
OLLAMA_MODEL = OLLAMA_TEXT_MODEL
OLLAMA_KEEP_ALIVE = OLLAMA_TEXT_KEEP_ALIVE
OLLAMA_WARMUP = _get_bool_env("OLLAMA_WARMUP", False)
OLLAMA_UNLOAD_AFTER_RESPONSE = _get_bool_env("OLLAMA_UNLOAD_AFTER_RESPONSE", False)
USE_OLLAMA = _get_bool_env("USE_OLLAMA", True)
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", "4000"))
MAX_AI_RESPONSE_TOKENS = int(os.getenv("MAX_AI_RESPONSE_TOKENS", "500"))
ENABLE_VISION_PDF_ANALYSIS = False
ENABLE_IMAGE_VISION_FALLBACK = False
OCR_REQUEST_TIMEOUT_MS = int(os.getenv("OCR_REQUEST_TIMEOUT_MS", os.getenv("VISION_REQUEST_TIMEOUT_MS", "60000")))
VISION_REQUEST_TIMEOUT_MS = OCR_REQUEST_TIMEOUT_MS
VISION_PDF_MAX_PAGES = 0
ARCHITECTURE_LOGS_ENABLED = _get_bool_env("ENABLE_ARCHITECTURE_LOGS", False)
DEBUG_RESOURCE_SEARCH = _get_bool_env("DEBUG_RESOURCE_SEARCH", False)
LOG_LEVEL = os.getenv("LOG_LEVEL", "debug")
LOG_DIR = os.getenv("LOG_DIR", "../logs")
LOG_PRETTY = _get_bool_env("LOG_PRETTY", True)
TESSERACT_CMD = os.getenv("TESSERACT_CMD", "")
