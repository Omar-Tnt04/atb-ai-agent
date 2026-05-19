import json
from typing import Any

from app.schemas.agent import AgentAnalyzeRequest


ALLOWED_INTENTS = [
    "check_balance",
    "view_transactions",
    "generate_document",
    "create_complaint",
    "book_appointment",
    "pay_bill",
    "make_transfer",
    "unknown",
]


def build_banking_intent_prompt(request: AgentAnalyzeRequest) -> str:
    available_actions = [
        action.model_dump() for action in request.availableActions
    ]

    prompt_context: dict[str, Any] = {
        "userMessage": request.message,
        "userRole": request.userRole,
        "availableActions": available_actions,
        "conversationHistory": request.conversationHistory,
    }

    return f"""
You are the intent analysis module for the ATB AI Banking Agent MVP.

Analyze the user's banking message and return ONLY valid JSON. Do not include
Markdown, code fences, explanations, or extra text.

Allowed languages:
- english
- french
- arabic
- unknown

Allowed intents:
{json.dumps(ALLOWED_INTENTS)}

Rules:
- Only choose an actionName that exists in availableActions.
- If no available action matches, use intent "unknown" and actionName null.
- actionName must be the same as intent when an action is selected.
- Extract obvious fields from the user message when possible.
- Use a formal banking advisor tone in assistantMessage.
- confidence must be a number between 0.0 and 1.0.

Return exactly this JSON structure:
{{
  "language": "english|french|arabic|unknown",
  "intent": "check_balance|view_transactions|generate_document|create_complaint|book_appointment|pay_bill|make_transfer|unknown",
  "actionName": "same_as_intent_or_null",
  "confidence": 0.0,
  "extractedFields": {{}},
  "assistantMessage": "formal banking advisor response"
}}

Context:
{json.dumps(prompt_context, ensure_ascii=False)}
""".strip()
