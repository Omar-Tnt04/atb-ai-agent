import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.schemas.agent import ResourceRerankCandidate, ResourceRerankRequest  # noqa: E402
from app.services import resource_reranker_service  # noqa: E402
from app.services import ollama_service  # noqa: E402
from app.services.ollama_service import OllamaJsonParseError, OllamaServiceError  # noqa: E402


def make_request(message: str, candidate_ids: list[str]) -> ResourceRerankRequest:
    candidates = [
        ResourceRerankCandidate(id=cid, title=cid.replace("_", " ").title())
        for cid in candidate_ids
    ]
    return ResourceRerankRequest(
        requestId="test_req",
        threadId="test_thread",
        message=message,
        candidates=candidates,
    )


class ResourceRerankValidationTests(unittest.TestCase):
    def test_valid_chosen_id_returned(self):
        raw = {"chosenId": "sonede_bill", "reason": "exact provider match", "confidence": 0.92}
        result = resource_reranker_service._validate_rerank_result(raw, ["sonede_bill", "telecom_bill"])
        self.assertEqual(result["chosenId"], "sonede_bill")
        self.assertAlmostEqual(result["confidence"], 0.92)

    def test_unknown_chosen_id_falls_back_to_first(self):
        raw = {"chosenId": "nonexistent_id", "reason": "wrong", "confidence": 0.5}
        result = resource_reranker_service._validate_rerank_result(raw, ["first_id", "second_id"])
        self.assertEqual(result["chosenId"], "first_id")

    def test_missing_chosen_id_falls_back_to_first(self):
        raw = {"reason": "no id provided", "confidence": 0.1}
        result = resource_reranker_service._validate_rerank_result(raw, ["first_id"])
        self.assertEqual(result["chosenId"], "first_id")

    def test_empty_candidates_raises(self):
        request = ResourceRerankRequest(requestId=None, threadId=None, message="test", candidates=[])
        with self.assertRaises(resource_reranker_service.ResourceRerankError):
            resource_reranker_service.rerank_resources(request)

    def test_single_candidate_skips_ollama(self):
        request = make_request("Pay my SONEDE bill", ["sonede_bill"])
        with patch("app.services.resource_reranker_service.rerank_resources_with_ollama") as mock_ollama:
            result = resource_reranker_service.rerank_resources(request)
        mock_ollama.assert_not_called()
        self.assertEqual(result["chosenId"], "sonede_bill")
        self.assertAlmostEqual(result["confidence"], 1.0)

    def test_ollama_called_for_multiple_candidates(self):
        request = make_request("Pay my SONEDE water bill", ["sonede_bill", "telecom_bill"])
        fake_response = {"chosenId": "sonede_bill", "reason": "SONEDE is mentioned", "confidence": 0.9}
        with patch("app.services.resource_reranker_service.rerank_resources_with_ollama", return_value=fake_response):
            result = resource_reranker_service.rerank_resources(request)
        self.assertEqual(result["chosenId"], "sonede_bill")

    def test_ollama_error_raises_rerank_error(self):
        request = make_request("Some bill", ["a", "b"])
        with patch(
            "app.services.resource_reranker_service.rerank_resources_with_ollama",
            side_effect=OllamaServiceError("unavailable"),
        ):
            with self.assertRaises(resource_reranker_service.ResourceRerankError):
                resource_reranker_service.rerank_resources(request)

    def test_json_parse_error_raises_rerank_error(self):
        request = make_request("Some bill", ["a", "b"])
        with patch(
            "app.services.resource_reranker_service.rerank_resources_with_ollama",
            side_effect=OllamaJsonParseError("bad json", "raw text"),
        ):
            with self.assertRaises(resource_reranker_service.ResourceRerankError):
                resource_reranker_service.rerank_resources(request)

    def test_specific_entity_chosen_over_generic(self):
        request = make_request(
            "What is the status of my SONEDE water bill payment?",
            ["sonede_bill", "generic_payment", "telecom_bill"],
        )
        fake_response = {"chosenId": "sonede_bill", "reason": "SONEDE explicitly mentioned", "confidence": 0.95}
        with patch("app.services.resource_reranker_service.rerank_resources_with_ollama", return_value=fake_response):
            result = resource_reranker_service.rerank_resources(request)
        self.assertEqual(result["chosenId"], "sonede_bill", "SONEDE entity must beat generic payment")

    def test_rerank_response_has_no_internal_metadata(self):
        raw = {"chosenId": "loan_offer", "reason": "user asked about loan", "confidence": 0.8}
        result = resource_reranker_service._validate_rerank_result(raw, ["loan_offer", "overdraft_alert"])
        forbidden = ["file name", "resource id", "category", "score", "mime type"]
        result_text = str(result)
        for term in forbidden:
            self.assertNotIn(term, result_text.lower(), f"Reranker result must not expose '{term}'")

    def test_ollama_prompt_uses_only_approved_candidate_fields(self):
        candidates = [
            {
                "id": "credit-card-limit-notice",
                "title": "Credit Card Limit Notice",
                "category": "cards",
                "description": "Credit card notice with payment due date.",
                "exampleQueries": ["When is my payment due?"],
                "intents": ["resource_qa"],
                "relatedActions": [],
                "score": 99,
                "resourceType": "card_notice",
                "tags": ["internal"],
                "fileName": "credit-card-limit.json",
                "path": "C:/laragon/www/credit-card-limit.json",
                "url": "http://localhost/credit-card-limit.json",
            }
        ]
        posted_payload = {}

        def fake_post_generate_json(_operation, payload, **_kwargs):
            posted_payload.update(payload)
            return {"response": '{"chosenId": "credit-card-limit-notice", "confidence": 0.9}'}

        with patch.object(ollama_service, "_post_generate_json", side_effect=fake_post_generate_json):
            ollama_service.rerank_resources_with_ollama("payment due", candidates)

        prompt = posted_payload["prompt"]
        self.assertIn("Description: Credit card notice with payment due date.", prompt)
        self.assertIn("Example queries: When is my payment due?", prompt)
        self.assertIn("Intents: resource_qa", prompt)
        self.assertNotIn("score", prompt.lower())
        self.assertNotIn("resourceType", prompt)
        self.assertNotIn("Tags:", prompt)
        self.assertNotIn("fileName", prompt)
        self.assertNotIn("C:/laragon", prompt)


if __name__ == "__main__":
    unittest.main()
