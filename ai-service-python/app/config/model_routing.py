import os
from dataclasses import dataclass


ROUTING_MODES = {"hybrid", "text_only"}


def normalize_routing_mode(value: str | None) -> str:
    mode = str(value or "").strip().lower()
    if mode == "vision_only":
        return "text_only"
    return mode if mode in ROUTING_MODES else "hybrid"


@dataclass(frozen=True)
class ModelSelection:
    model_routing_mode: str
    selected_model: str
    selected_keep_alive: str
    selected_model_reason: str
    vision_used: bool
    direct_vision_supported: bool


MODEL_ROUTING_MODE = normalize_routing_mode(os.getenv("MODEL_ROUTING_MODE"))
OLLAMA_TEXT_MODEL = os.getenv("OLLAMA_TEXT_MODEL", "qwen2.5:7b")
OLLAMA_TEXT_KEEP_ALIVE = os.getenv("OLLAMA_TEXT_KEEP_ALIVE", "30s")


def select_model(*, requires_vision: bool = False) -> ModelSelection:
    if MODEL_ROUTING_MODE == "text_only":
        return ModelSelection(
            model_routing_mode=MODEL_ROUTING_MODE,
            selected_model=OLLAMA_TEXT_MODEL,
            selected_keep_alive=OLLAMA_TEXT_KEEP_ALIVE,
            selected_model_reason=(
                "text_only uses the text model; direct vision is unsupported"
                if requires_vision
                else "text_only routes text tasks to the text model"
            ),
            vision_used=False,
            direct_vision_supported=False,
        )

    return ModelSelection(
        model_routing_mode=MODEL_ROUTING_MODE,
        selected_model=OLLAMA_TEXT_MODEL,
        selected_keep_alive=OLLAMA_TEXT_KEEP_ALIVE,
        selected_model_reason=(
            "hybrid keeps the vision model disabled; OCR output is handled by the text model"
            if requires_vision
            else "hybrid routes JSON, TXT, PDF-text, and resource tasks to the text model"
        ),
        vision_used=False,
        direct_vision_supported=False,
    )
