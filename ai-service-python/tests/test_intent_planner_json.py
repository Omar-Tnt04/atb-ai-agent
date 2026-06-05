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
            '```json\n{"mode":"resource_qa","needsResourceSearch":true}\n```'
        )

        self.assertEqual(parsed["mode"], "resource_qa")
        self.assertTrue(parsed["needsResourceSearch"])

    def test_prefixed_planner_json_parses(self):
        parsed = _extract_json_object(
            'Here is the plan:\n{"mode":"resource_qa","needsResourceSearch":true}'
        )

        self.assertEqual(parsed["mode"], "resource_qa")
        self.assertTrue(parsed["needsResourceSearch"])

    def test_planner_parse_failure_returns_safe_fallback(self):
        request = make_request()

        with patch.object(intent_planner_service.settings, "USE_OLLAMA", True), patch.object(
            intent_planner_service,
            "plan_intent_with_ollama",
            side_effect=OllamaJsonParseError("bad json", "not json"),
        ):
            decision = intent_planner_service.plan_intent(request)

        self.assertEqual(decision["mode"], "resource_search")
        self.assertTrue(decision["needsResourceSearch"])
        self.assertEqual(decision["resourceSearchQuery"], request.message)
        self.assertEqual(decision["confidence"], 0.4)


if __name__ == "__main__":
    unittest.main()
