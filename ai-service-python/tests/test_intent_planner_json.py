import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.schemas.agent import AgentAnalyzeRequest  # noqa: E402
from app.services import intent_planner_service  # noqa: E402
from app.services.ollama_service import (  # noqa: E402
    OllamaJsonParseError,
    _extract_json_object,
)


def make_request(message: str = "What is the status of my debit card replacement request?"):
    return AgentAnalyzeRequest(
        requestId="test_request",
        threadId="test_thread",
        message=message,
        userRole="client",
    )


class IntentPlannerJsonTests(unittest.TestCase):
    def test_fenced_planner_json_parses(self):
        parsed = _extract_json_object(
            '```json\n{"intentType":"resource_qa","resourceNeed":true,"resourceQuery":"card limit"}\n```'
        )

        self.assertEqual(parsed["intentType"], "resource_qa")
        self.assertTrue(parsed["resourceNeed"])

    def test_prefixed_planner_json_parses(self):
        parsed = _extract_json_object(
            'Here is the plan:\n{"intentType":"resource_qa","resourceNeed":true,"resourceQuery":"security notice"}'
        )

        self.assertEqual(parsed["intentType"], "resource_qa")
        self.assertTrue(parsed["resourceNeed"])

    def test_planner_parse_failure_returns_safe_fallback(self):
        request = make_request()

        with patch.object(intent_planner_service.settings, "USE_OLLAMA", True), patch.object(
            intent_planner_service,
            "plan_intent_with_ollama",
            side_effect=OllamaJsonParseError("bad json", "not json"),
        ):
            decision = intent_planner_service.plan_intent(request)

        self.assertEqual(decision["intentType"], "multi_resource_search")
        self.assertTrue(decision["resourceNeed"])
        self.assertEqual(decision["resourceQuery"], request.message)
        self.assertEqual(decision["confidence"], 0.4)

    def test_new_planner_schema_validates(self):
        request = make_request("Pay my Telecom bill from acc_001.")
        raw = {
            "intentType": "action_prepare",
            "userGoal": "pay telecom bill",
            "resourceNeed": True,
            "resourceQuery": "Telecom bill",
            "resourceCategoryHint": "payment",
            "actionType": "pay_bill",
            "needsVision": False,
            "needsDownload": False,
            "missingFields": [],
            "confidence": 0.91,
        }

        decision = intent_planner_service._validate_planner_result(raw, request)

        self.assertEqual(decision["intentType"], "action_prepare")
        self.assertEqual(decision["actionType"], "pay_bill")
        self.assertEqual(decision["resourceQuery"], "Telecom bill")
        self.assertEqual(decision["confidence"], 0.91)


if __name__ == "__main__":
    unittest.main()
