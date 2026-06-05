import os

from dotenv import load_dotenv


load_dotenv()


def _get_bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)

    if value is None:
        return default

    return value.strip().lower() in {"1", "true", "yes", "on"}


OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = "qwen3-vl:8b"
OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "3m")
OLLAMA_WARMUP = _get_bool_env("OLLAMA_WARMUP", False)
OLLAMA_UNLOAD_AFTER_RESPONSE = _get_bool_env("OLLAMA_UNLOAD_AFTER_RESPONSE", False)
USE_OLLAMA = _get_bool_env("USE_OLLAMA", True)
ENABLE_VISION_PDF_ANALYSIS = _get_bool_env("ENABLE_VISION_PDF_ANALYSIS", True)
VISION_PDF_MAX_PAGES = int(os.getenv("VISION_PDF_MAX_PAGES", "3"))
ARCHITECTURE_LOGS_ENABLED = _get_bool_env("ARCHITECTURE_LOGS_ENABLED", True)
LOG_LEVEL = os.getenv("LOG_LEVEL", "debug")
LOG_DIR = os.getenv("LOG_DIR", "../logs")
LOG_PRETTY = _get_bool_env("LOG_PRETTY", True)
