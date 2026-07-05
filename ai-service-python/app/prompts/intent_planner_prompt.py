import json
from typing import Any

from app.schemas.agent import AgentAnalyzeRequest


ALLOWED_PLANNER_INTENT_TYPES = [
    "resource_qa",
    "document_show",
    "action_prepare",
    "multi_resource_search",
    "account_balance",
    "clarification",
    "no_match",
]

ALLOWED_PLANNER_MODES = ALLOWED_PLANNER_INTENT_TYPES


def _build_hints_block(request: AgentAnalyzeRequest) -> str:
    """Build a compact pre-classification hints block from threadContext, requestContext, agentPlan.
    Returns empty string when none of the hint sources are present.
    All hints are non-binding — they inform the LLM but do not override its judgment."""
    lines: list[str] = []

    # Intent pre-classifier result (deterministic keyword match, Node.js side)
    if request.requestContext and request.requestContext.intentClass:
        ic = request.requestContext.intentClass
        intent_type = ic.get("type", "unclear")
        confidence = ic.get("confidence", 0.0)
        target = ic.get("target", "")
        hint = f"- Pre-classified intent: {intent_type} (conf: {confidence:.2f})"
        if target:
            hint += f', target: "{str(target)[:45]}"'
        lines.append(hint)

    # Prior turn count and last resolved intent from conversation memory
    if request.threadContext:
        tc = request.threadContext
        if tc.priorTurns:
            lines.append(f"- Prior turns in this thread: {len(tc.priorTurns)}")
        if tc.lastIntent:
            lines.append(f"- Last resolved intent: {tc.lastIntent}")

    # Current page (URL + title) — present when the widget is open on an ATB page
    if request.requestContext and request.requestContext.currentPage:
        cp = request.requestContext.currentPage
        title = str(cp.get("title", "") or "").strip()
        url = str(cp.get("url", "") or "").strip()
        label = (title[:50] if title else url[:60]) or None
        if label:
            lines.append(f'- User\'s current page: "{label}"')

    # Page signal counts — how many links / downloads are visible
    if request.requestContext and request.requestContext.pageSignals:
        ps = request.requestContext.pageSignals
        links = int(ps.get("visibleLinksCount", 0) or 0)
        downloads = int(ps.get("downloadLinksCount", 0) or 0)
        if links or downloads:
            lines.append(f"- Page signals: {links} visible links, {downloads} download links")

    # Retrieval paths the pre-classifier thinks are likely needed
    if request.requestContext and request.requestContext.retrievalHints:
        rh = request.requestContext.retrievalHints
        active = [
            k.replace("shouldUse", "").lower()
            for k, v in rh.items()
            if v and k.startswith("shouldUse")
        ]
        if active:
            lines.append(f"- Suggested retrieval paths: {', '.join(active)}")

    # Deterministic plan produced by Node.js agentPlanner (treat as a strong hint, not a command)
    if request.agentPlan:
        plan = request.agentPlan
        executor = plan.executorType or "unknown"
        route = plan.selectedRoute or "unknown"
        lines.append(
            f"- Deterministic plan: executor={executor} route={route}"
            f" (conf: {plan.confidence:.2f}, allowed: {plan.allowed})"
        )
        if not plan.allowed:
            lines.append(
                "- SAFETY FLAG: The pre-classifier marked this as a sensitive action. "
                "Do not prepare any financial transaction or credential action."
            )

    if not lines:
        return ""

    return (
        "Pre-classification hints (deterministic rules, non-binding — use as supporting signal only):\n"
        + "\n".join(lines)
        + "\n\n"
    )


def build_intent_planner_prompt(request: AgentAnalyzeRequest) -> str:
    available_actions = [action.model_dump() for action in request.availableActions]
    prompt_context: dict[str, Any] = {
        "userMessage": request.message,
        "userRole": request.userRole,
        "availableActions": available_actions,
        "conversationHistory": request.conversationHistory[-6:],
        "hasUploadedFiles": bool(request.fileContext and request.fileContext.hasUploadedFiles),
        "agentContext": request.agentContext.model_dump() if request.agentContext else None,
    }

    hints_block = _build_hints_block(request)

    return f"""
You are the first-stage Ollama NLP intent planner for a banking AI agent.

Return ONLY valid JSON. Do not include Markdown, code fences, comments, or
explanations outside the JSON object.

Classify the user's request into one intentType:
{json.dumps(ALLOWED_PLANNER_INTENT_TYPES)}

Plan from user intent, not from a fixed catalog of demo resource names. Future
bank resources may have new names. Use the user's words to form the search
query.

Decision questions:
- Is the user asking about their own banking data or saved bank information?
- Is the user asking for a document, form, receipt, certificate, status,
  request, appointment, payment, transfer, account, card, branch, product, or
  other bank-provided information?
- Would a correct answer require server-side/private resource lookup?
- Is the user trying to prepare a banking action that backend tools must
  validate before execution?

Intent rules:
- resource_qa: The user asks a question whose answer may be in bank resources
  or private server-side records. Use resourceNeed true.
- document_show: The user asks to show, open, download, view, or retrieve a
  specific document-like resource. Use resourceNeed true and needsDownload true
  when a stored PDF/document should be offered.
- action_prepare: The user asks to prepare a payment, transfer, appointment,
  complaint, cancel/reset, or another supported action. Use the closest actionType.
  IMPORTANT: action_prepare is ONLY for true new actions. A retrieval verb
  (download, open, view, get, show, fetch, find, access, retrieve) combined with
  a document noun (statement, PDF, certificate, receipt, document) is NEVER
  action_prepare — it is document_show. Only explicit generation verbs (generate,
  create, prepare, issue, make, produce, new) should trigger action_prepare for
  document generation.
- multi_resource_search: The user asks to find/list/search anything related to
  a topic or broad category. Use resourceNeed true.
- account_balance: The user asks for their account balance. This is an account
  action/clarification path, not a resource lookup unless they name a stored
  statement or document.
- Card/resource questions are resource_qa, not account_balance. This includes
  "credit card limit", "card limit", "available limit", "available card limit",
  "minimum payment", "payment due date", and "card notice".
- clarification: The user likely wants a resource or action, but the target is
  too unclear to choose a mode or search query safely.
- no_match: The user asks a general educational or conversational question that
  does not require private resource lookup or action flow.

Statement/document retrieval vs generation rule:
- "Download my card statement PDF" -> document_show, needsDownload true,
  resourceQuery "card statement", NOT action_prepare.
- "Get my account statement" -> document_show, needsDownload true,
  resourceQuery "account statement", NOT action_prepare.
- "Open / view / show my statement" -> document_show, needsDownload true.
- "Generate a new account statement for May 2026" -> action_prepare,
  actionType "document_generation".
- "Create / prepare / issue an account statement" -> action_prepare,
  actionType "document_generation".
The distinction: retrieval verbs (download/get/open/view/show/fetch) = document_show;
generation verbs (generate/create/prepare/issue/make/new) = action_prepare.

Generic examples:
- "How do I activate X?" -> resource_qa with resourceQuery
  "activation guide for X".
- "Show me my X" -> document_show with resourceQuery "X".
- "What is the status of my X?" -> resource_qa with resourceQuery
  "status of X".
- "What is my credit card limit?" -> resource_qa with resourceQuery
  "credit card limit", not account_balance.
- "What is my available card limit?" -> resource_qa with resourceQuery
  "credit card limit".
- "When is my card payment due?" -> resource_qa with resourceQuery
  "credit card limit".
- "What happened in my SMS card alert?" -> resource_qa with resourceQuery
  "SMS card alert".
- "What does X notice recommend?" -> resource_qa with resourceQuery
  "X notice".
- "Do I have an appointment for X?" -> resource_qa with resourceQuery
  "appointment for X".
- "Pay my X bill from account Y" -> action_prepare, actionType "pay_bill",
  resourceQuery "X bill".
- "Find anything related to X" -> multi_resource_search with resourceQuery "X".
- "What is my account balance?" -> account_balance, actionType "none",
  resourceNeed false.

Security rules:
- Do not execute actions, approve confirmations, send SMS codes, or expose
  private data.
- Do not invent account, bill, receipt, document, appointment, transfer, or PDF
  contents.
- Only produce a plan. Backend services will validate resources, actions, and
  permissions.

Return exactly this JSON shape:
{{
  "intentType": "resource_qa|document_show|action_prepare|multi_resource_search|account_balance|clarification|no_match",
  "userGoal": "short normalized goal",
  "resourceNeed": true,
  "resourceQuery": "short resource search query using the user's words or null",
  "resourceCategoryHint": "optional generic category or null",
  "actionType": "pay_bill|transfer|complaint|appointment|cancel|reset|none",
  "needsVision": false,
  "needsDownload": false,
  "missingFields": [],
  "confidence": 0.0
}}

{hints_block}Context:
{json.dumps(prompt_context, ensure_ascii=False)}
""".strip()
