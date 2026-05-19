import json
import re
from typing import Any

import requests

from app.config import settings
from app.prompts.banking_intent_prompt import build_banking_intent_prompt
from app.schemas.agent import AgentAnalyzeRequest


class OllamaServiceError(Exception):
    """Raised when Ollama is unavailable or returns unusable output."""


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned_text = text.strip()

    if cleaned_text.startswith("```"):
        cleaned_text = re.sub(r"^```(?:json)?", "", cleaned_text).strip()
        cleaned_text = re.sub(r"```$", "", cleaned_text).strip()

    try:
        parsed = json.loads(cleaned_text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned_text, re.DOTALL)
        if not match:
            raise OllamaServiceError("Ollama response did not contain JSON")
        parsed = json.loads(match.group(0))

    if not isinstance(parsed, dict):
        raise OllamaServiceError("Ollama JSON response must be an object")

    return parsed


def analyze_with_ollama(request: AgentAnalyzeRequest) -> dict[str, Any]:
    prompt = build_banking_intent_prompt(request)

    try:
        response = requests.post(
            f"{settings.OLLAMA_BASE_URL}/api/generate",
            json={
                "model": settings.OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
                "format": "json",
                "options": {
                    "temperature": 0,
                    "num_predict": 300,
                },
            },
            timeout=20,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise OllamaServiceError("Ollama is unavailable") from exc

    payload = response.json()
    response_text = payload.get("response")

    if not isinstance(response_text, str):
        raise OllamaServiceError("Ollama response text is missing")

    return _extract_json_object(response_text)
