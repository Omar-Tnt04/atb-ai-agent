import json
from typing import Any

from app.schemas.agent import AgentAnalyzeRequest


ALLOWED_INTENTS = [
    "analyze_uploaded_file",
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
        "fileContext": request.fileContext.model_dump()
        if request.fileContext
        else None,
        "profileContext": request.profileContext.model_dump()
        if request.profileContext
        else None,
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
- If fileContext is present, use its combinedText and file metadata as
  additional context for intent detection and field extraction.
- If profileContext is present, use it only as private user context. RIB can
  help clarify account/source-account questions, but it must not bypass
  confirmation or SMS verification.
- If the user asks to understand, read, analyze, summarize, explain, or extract
  information from an uploaded file, use intent "analyze_uploaded_file" and
  actionName null. Do not choose generate_document for summaries.
- Only choose generate_document when the user explicitly asks to generate,
  download, create, or request a statement, RIB, certificate, attestation, or
  document.
- Use a formal banking advisor tone in assistantMessage.
- assistantMessage should be concise Markdown. Use bold section labels and
  bullet lists when asking for missing information. Do not include raw JSON.
- If details are missing, clearly list them under "**Required information**"
  and end with: "Choose one of the options below or type your answer."
- confidence must be a number between 0.0 and 1.0.

Return exactly this JSON structure:
{{
  "language": "english|french|arabic|unknown",
  "intent": "analyze_uploaded_file|check_balance|view_transactions|generate_document|create_complaint|book_appointment|pay_bill|make_transfer|unknown",
  "actionName": "same_as_intent_or_null",
  "confidence": 0.0,
  "extractedFields": {{}},
  "assistantMessage": "formal banking advisor Markdown response"
}}

Context:
{json.dumps(prompt_context, ensure_ascii=False)}
""".strip()
