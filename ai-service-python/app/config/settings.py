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
OLLAMA_VISION_MODEL = model_routing.OLLAMA_VISION_MODEL
OLLAMA_TEXT_KEEP_ALIVE = model_routing.OLLAMA_TEXT_KEEP_ALIVE
OLLAMA_VISION_KEEP_ALIVE = model_routing.OLLAMA_VISION_KEEP_ALIVE
OLLAMA_MODEL = OLLAMA_VISION_MODEL
OLLAMA_KEEP_ALIVE = OLLAMA_VISION_KEEP_ALIVE
OLLAMA_WARMUP = _get_bool_env("OLLAMA_WARMUP", False)
OLLAMA_UNLOAD_AFTER_RESPONSE = _get_bool_env("OLLAMA_UNLOAD_AFTER_RESPONSE", False)
USE_OLLAMA = _get_bool_env("USE_OLLAMA", True)
MAX_CONTEXT_CHARS = int(os.getenv("MAX_CONTEXT_CHARS", "4000"))
MAX_AI_RESPONSE_TOKENS = int(os.getenv("MAX_AI_RESPONSE_TOKENS", "500"))
ENABLE_VISION_PDF_ANALYSIS = _get_bool_env("ENABLE_VISION_PDF_ANALYSIS", True)
VISION_PDF_MAX_PAGES = int(os.getenv("VISION_PDF_MAX_PAGES", "3"))
ARCHITECTURE_LOGS_ENABLED = _get_bool_env("ARCHITECTURE_LOGS_ENABLED", True)
LOG_LEVEL = os.getenv("LOG_LEVEL", "debug")
LOG_DIR = os.getenv("LOG_DIR", "../logs")
LOG_PRETTY = _get_bool_env("LOG_PRETTY", True)
