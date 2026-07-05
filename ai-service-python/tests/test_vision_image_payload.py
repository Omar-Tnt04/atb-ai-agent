import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.modules.setdefault("fitz", types.ModuleType("fitz"))

from app.schemas.agent import VisionDocumentAnalyzeRequest  # noqa: E402
from app.services.ollama_service import (  # noqa: E402
    OllamaServiceError,
    _request_vision_generate,
)
from app.services.vision_document_service import (  # noqa: E402
    analyze_vision_document,
    _build_image_extraction_prompt,
    _normalize_image_result,
    _parse_ocr_fields,
    _to_camel_case,
    _ocr_sufficient,
    _match_question_to_ocr_fields,
    _search_answer_in_raw_text,
)


class FakeOllamaResponse:
    status_code = 200
    headers = {"content-type": "application/json"}
    text = '{"response":"{}"}'

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload

    def raise_for_status(self):
        return None


class VisionImagePayloadTests(unittest.TestCase):
    def test_direct_vision_generate_is_disabled_before_network_call(self):
        posted = []

        def fake_post(*args, **kwargs):
            posted.append((args, kwargs))
            return FakeOllamaResponse({"response": "{}"})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post):
            with self.assertRaises(OllamaServiceError) as context:
                _request_vision_generate(
                    "Read this banking image.",
                    ["aW1hZ2UtYnl0ZXM="],
                    "primary",
                    1,
                    {"is_image_payload": True},
                )

        self.assertEqual(str(context.exception), "vision_model_disabled")
        self.assertEqual(posted, [])

    @unittest.skip("obsolete: runtime vision model path is disabled")
    def test_image_request_forwards_base64_in_ollama_images_field(self):
        posted = {}

        def fake_post(url, json, timeout):
            posted["url"] = url
            posted["json"] = json
            posted["timeout"] = timeout
            return FakeOllamaResponse({
                "response": '{"amount":"42.000","currency":"TND"}',
            })

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.ollama_service.settings.OLLAMA_UNLOAD_AFTER_RESPONSE",
            False,
        ):
            response = _request_vision_generate(
                "Read this banking image.",
                ["aW1hZ2UtYnl0ZXM="],
                "primary",
                1,
                {"is_image_payload": True},
            )

        self.assertIn("/api/generate", posted["url"])
        self.assertEqual(posted["json"]["model"], "qwen3-vl:8b")
        self.assertEqual(posted["json"]["images"], ["aW1hZ2UtYnl0ZXM="])
        # format: "json" removed — grammar-constrained sampling conflicts with qwen3-vl vision output
        self.assertNotIn("format", posted["json"])
        self.assertIn('"amount"', response)

    @unittest.skip("obsolete: runtime vision model path is disabled")
    def test_image_payload_matches_working_direct_ollama_request(self):
        """Payload sent to Ollama must match the working direct /api/generate call.

        Working reference:
          endpoint: http://localhost:11434/api/generate
          model: qwen3-vl:8b
          images: [base64]
          stream: false
          options.temperature: 0
          options.num_predict: 500

        The app adds think:false and keep_alive which are safe additions.
        It must NOT add format:"json" — grammar-constrained sampling conflicts
        with qwen3-vl vision output and causes empty_ollama_response failures.
        """
        posted = {}

        def fake_post(url, json, timeout):
            posted["url"] = url
            posted["json"] = json
            return FakeOllamaResponse({"response": '{"activationChannel":"ATM or ATB Connect"}'})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.ollama_service.settings.OLLAMA_UNLOAD_AFTER_RESPONSE", False
        ):
            _request_vision_generate(
                "What is the activation channel?",
                ["base64imagedata"],
                "primary",
                1,
                {"is_image_payload": True},
            )

        payload = posted["json"]
        self.assertIn("/api/generate", posted["url"])
        self.assertEqual(payload["model"], "qwen3-vl:8b")
        self.assertEqual(payload["images"], ["base64imagedata"])
        self.assertFalse(payload.get("stream"), "stream must be false")
        self.assertNotIn("format", payload, "format:json must not be set for vision requests")
        self.assertEqual(payload["options"]["temperature"], 0.0)
        self.assertGreater(payload["options"]["num_predict"], 0)

    def test_image_prompt_is_strict_and_metadata_free(self):
        request = VisionDocumentAnalyzeRequest(
            message="read it",
            userRole="CLIENT",
            mimeType="image/png",
            pdfBase64="aW1hZ2U=",
            fileName="receipt.png",
            resourceJson={"title": "QR receipt", "amount": "999.000"},
        )

        prompt = _build_image_extraction_prompt(request, "Merchant: ATB Shop\nAmount: 42.000 TND")

        self.assertIn("Analyze this banking image. OCR text is provided as helper context.", prompt)
        self.assertIn("Merchant: ATB Shop", prompt)
        self.assertIn('"summary": null', prompt)
        self.assertNotIn("999.000", prompt)
        self.assertNotIn("QR receipt", prompt)

    def test_mocked_vision_json_returns_extracted_answer(self):
        request = VisionDocumentAnalyzeRequest(
            message="read image",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Metadata title"},
        )

        normalized = _normalize_image_result(
            {
                "documentType": "payment_receipt",
                "merchant": "ATB Shop",
                "amount": "42.000",
                "currency": "TND",
                "summary": "ATB Shop receipt for 42.000 TND.",
            },
            request,
            "factual_question",
            "Metadata title",
        )

        self.assertIn("42.000", normalized["assistantMessage"])
        self.assertEqual(normalized["extractedFields"]["merchant"], "ATB Shop")
        self.assertEqual(normalized["extractedFields"]["amount"], "42.000")
        self.assertNotIn("Metadata title", normalized["assistantMessage"])

    def test_image_prompt_requests_all_visible_card_fields(self):
        request = VisionDocumentAnalyzeRequest(
            message="What visual elements are shown in the debit card activation image?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
        )

        prompt = _build_image_extraction_prompt(request, "")

        # The schema must request more than receipt fields so card-activation fields are not lost.
        for key in ("noticeId", "cardType", "activationChannel", "expiry", "recommendedStep", '"fields"'):
            self.assertIn(key, prompt)
        self.assertIn("Read ALL visible text", prompt)

    def test_card_activation_image_keeps_all_visible_fields(self):
        request = VisionDocumentAnalyzeRequest(
            message="What visual elements are shown in the debit card activation image?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Debit Card Activation Notice", "resourceType": "card_activation"},
        )

        normalized = _normalize_image_result(
            {
                "documentType": "card_activation_notice",
                "noticeId": "CARD-ACT-2026-052",
                "card": "************4455",
                "cardType": "Debit",
                "activationChannel": "ATM or ATB Connect",
                "expiry": "05/29",
                "status": "Pending activation",
                "recommendedStep": "Activate before first purchase",
                "summary": (
                    "Notice ID: CARD-ACT-2026-052. Card: ************4455. Card type: Debit. "
                    "Activation channel: ATM or ATB Connect. Expiry: 05/29. "
                    "Status: Pending activation. Recommended step: Activate before first purchase."
                ),
            },
            request,
            "factual_question",
            "Debit Card Activation Notice",
        )

        answer = normalized["assistantMessage"]
        for field in (
            "CARD-ACT-2026-052",
            "************4455",
            "Debit",
            "ATM or ATB Connect",
            "05/29",
            "Pending activation",
            "Activate before first purchase",
        ):
            self.assertIn(field, answer, f"missing {field} in {answer!r}")
        self.assertEqual(normalized["extractedFields"]["cardType"], "Debit")
        self.assertEqual(normalized["extractedFields"]["activationChannel"], "ATM or ATB Connect")
        self.assertEqual(normalized["extractedFields"]["recommendedStep"], "Activate before first purchase")

    def test_card_activation_fields_survive_when_model_omits_summary(self):
        request = VisionDocumentAnalyzeRequest(
            message="What is shown in this image?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Debit Card Activation Notice"},
        )

        # No "summary" from the model and the extra fields delivered via the free-form "fields"
        # object — the normalizer must still build a complete multi-field answer (never one field).
        normalized = _normalize_image_result(
            {
                "documentType": "card_activation_notice",
                "card": "************4455",
                "status": "Pending activation",
                "fields": {
                    "noticeId": "CARD-ACT-2026-052",
                    "cardType": "Debit",
                    "activationChannel": "ATM or ATB Connect",
                    "expiry": "05/29",
                    "recommendedStep": "Activate before first purchase",
                },
                "summary": None,
            },
            request,
            "factual_question",
            "Debit Card Activation Notice",
        )

        answer = normalized["assistantMessage"]
        for field in (
            "CARD-ACT-2026-052",
            "************4455",
            "Debit",
            "ATM or ATB Connect",
            "05/29",
            "Pending activation",
            "Activate before first purchase",
        ):
            self.assertIn(field, answer, f"missing {field} in {answer!r}")

    def test_ocr_parser_filters_demo_noise_and_table_headers(self):
        ocr = """
        DEMO BANKING IMAGE RESOURCE - Debit Card Activation Notice
        Visible Fields
        | Field | Value |
        | Notice ID | CARD-ACT-2026-052 |
        | Card | ************4455 |
        | Card type | Debit |
        | Activation channel | ATM or ATB Connect |
        | Expiry | 05/29 |
        | Status | Pending activation |
        | Recommended step | Activate before first purchase |
        Agent Expected Behavior:
        Synthetic ATB demo image for testing.
        resourceId: IMG-CARD-ACT-2026-052
        """

        parsed = _parse_ocr_fields(ocr)
        fields = parsed["extractedFields"]

        self.assertEqual(fields["noticeId"], "CARD-ACT-2026-052")
        self.assertEqual(fields["card"], "************4455")
        self.assertEqual(fields["cardType"], "Debit")
        self.assertEqual(fields["activationChannel"], "ATM or ATB Connect")
        self.assertEqual(fields["expiry"], "05/29")
        self.assertEqual(fields["status"], "Pending activation")
        self.assertEqual(fields["recommendedStep"], "Activate before first purchase")
        self.assertNotIn("field", fields)
        self.assertNotIn("visibleFields", fields)
        self.assertNotIn("resourceId", fields)
        self.assertNotIn("agentExpectedBehavior", fields)

    def test_debit_card_activation_resource_keeps_only_expected_ocr_fields(self):
        noisy_ocr = """
        ATB
        DEMO BANKING IMAGE RESOURCE
        Field | Value
        Notice ID | CARD-ACT-2026-052
        Card | 55
        Card type | Debit
        Activation channel | ATM or ATB Connect
        Expiry | 05/29
        Status | Pending activation
        Recommended step | Activate before first purchase
        activate Before First purchase
        Agent Expected Behavior text
        Synthetic footer
        """
        request = VisionDocumentAnalyzeRequest(
            message="Read my debit card activation notice image",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            fileName="03_card_activation_notice.jpeg",
            resourceJson={"title": "Debit Card Activation Notice", "resourceType": "card_activation"},
        )

        with patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_ocr",
            return_value=b"processed-image",
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value=noisy_ocr,
        ), patch(
            "app.services.ollama_service.requests.post",
            side_effect=AssertionError("vision must not be called for normalized debit card OCR"),
        ):
            result = analyze_vision_document(request)

        expected = {
            "noticeId": "CARD-ACT-2026-052",
            "card": "************4455",
            "cardType": "Debit",
            "activationChannel": "ATM or ATB Connect",
            "expiry": "05/29",
            "status": "Pending activation",
            "recommendedStep": "Activate before first purchase",
        }
        self.assertEqual(result["extractedFields"], expected)
        answer = result["assistantMessage"]
        for value in expected.values():
            self.assertIn(value, answer)
        for forbidden in (
            "DEMO BANKING IMAGE RESOURCE",
            "Field is Value",
            "Agent Expected Behavior",
            "card is 55",
            "activate Before First is purchase",
        ):
            self.assertNotIn(forbidden, answer)

    @unittest.skip("obsolete: runtime vision model path is disabled")
    def test_empty_vision_response_raises_clean_failure(self):
        with patch(
            "app.services.ollama_service.requests.post",
            return_value=FakeOllamaResponse({"response": ""}),
        ), patch("app.services.ollama_service.settings.OLLAMA_UNLOAD_AFTER_RESPONSE", False):
            with self.assertRaises(OllamaServiceError) as context:
                _request_vision_generate(
                    "Read this banking image.",
                    ["aW1hZ2U="],
                    "primary",
                    1,
                    {"is_image_payload": True},
                )

        self.assertEqual(str(context.exception), "empty_ollama_response")

    @unittest.skip("obsolete: OCR no longer falls back to vision")
    def test_image_document_runs_ocr_before_vision_and_passes_ocr_text(self):
        """OCR runs first; vision called only when OCR is insufficient (sparse OCR → vision invoked)."""
        request = VisionDocumentAnalyzeRequest(
            message="read image",
            userRole="CLIENT",
            mimeType="image/png",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Metadata title", "amount": "999.000"},
        )
        calls = []
        captured = {}

        def fake_vision(prompt, images, retry_attempts=None, log_context=None):
            calls.append("vision")
            captured["prompt"] = prompt
            captured["images"] = images
            captured["log_context"] = log_context
            return {
                "documentType": "payment_receipt",
                "merchant": "ATB Shop",
                "amount": "42.000",
                "currency": "TND",
                "summary": "ATB Shop receipt for 42.000 TND.",
            }

        def fake_ocr(image_bytes):
            calls.append("ocr")
            # Return only one weak field (date) so OCR is insufficient and vision is called.
            return "Date: 2026-01-01"

        with patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("processed-base64", b"processed-image"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            side_effect=fake_ocr,
        ), patch(
            "app.services.vision_document_service.analyze_vision_images_with_ollama",
            side_effect=fake_vision,
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            True,
        ):
            normalized = analyze_vision_document(request)

        # OCR is now called twice (original + preprocessed); vision must still run after
        ocr_count = calls.count("ocr")
        self.assertGreaterEqual(ocr_count, 1, "OCR must run at least once")
        self.assertIn("vision", calls, "vision must be called when OCR is insufficient")
        self.assertLess(calls.index("ocr"), calls.index("vision"), "OCR must run before vision")
        self.assertEqual(captured["images"], [""])
        self.assertIn("Date: 2026-01-01", captured["prompt"])
        self.assertEqual(normalized["extractedFields"]["amount"], "42.000")
        self.assertNotIn("999.000", normalized["assistantMessage"])


    @unittest.skip("obsolete: runtime vision model path is disabled")
    def test_plain_text_response_not_treated_as_empty(self):
        """Ollama returning plain text 'ATM or ATB Connect' must NOT raise empty_ollama_response.

        Root cause being fixed: think:False suppressed qwen3-vl:8b response field.
        Working direct PowerShell call returned plain text without JSON.
        Python must accept that and not reject it as empty.
        """
        posted = {}

        def fake_post(url, json, timeout):
            posted["json"] = json
            return FakeOllamaResponse({"response": "ATM or ATB Connect"})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.ollama_service.settings.OLLAMA_UNLOAD_AFTER_RESPONSE", False
        ):
            response_text = _request_vision_generate(
                "What is the activation channel?",
                ["base64imagedata"],
                "primary",
                1,
                {"is_image_payload": True},
            )

        self.assertEqual(response_text, "ATM or ATB Connect")
        self.assertNotIn("think", posted["json"], "think:False must not be in payload")
        self.assertNotIn("format", posted["json"], "format:json must not be in payload")

    @unittest.skip("obsolete: runtime vision model path is disabled")
    def test_thinking_overflow_retries_with_short_prompt(self):
        """qwen3-vl returning empty response + non-empty thinking + done_reason=length
        must trigger retry with short direct prompt, which returns 'ATM or ATB Connect',
        parsed into activationChannel in extractedFields.
        """
        call_log = []

        def fake_post(url, json, timeout):
            call_log.append({"prompt_length": len(json.get("prompt", "")), "num_predict": json["options"]["num_predict"]})
            if len(call_log) == 1:
                # Primary: thinking overflow — all tokens consumed by thinking
                return FakeOllamaResponse({
                    "response": "",
                    "thinking": "I need to look at the image carefully... " * 40,
                    "done_reason": "length",
                    "eval_count": 80,
                })
            # Retry (field_fallback): short prompt returns plain text
            return FakeOllamaResponse({"response": "ATM or ATB Connect"})

        request = VisionDocumentAnalyzeRequest(
            message="What is the activation channel in the debit card activation image?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Debit Card Activation Notice"},
        )

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.ollama_service.settings.OLLAMA_UNLOAD_AFTER_RESPONSE", False
        ), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="",  # empty OCR forces vision path so thinking-overflow retry is exercised
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            True,
        ):
            normalized = analyze_vision_document(request)

        self.assertEqual(len(call_log), 2, "must retry exactly once after thinking overflow")
        # Primary uses num_predict=80 (single-field), retry uses num_predict=50 (field_fallback)
        self.assertEqual(call_log[0]["num_predict"], 80)
        self.assertEqual(call_log[1]["num_predict"], 50)
        # activationChannel must be in final answer
        self.assertIn("ATM or ATB Connect", normalized["assistantMessage"])
        self.assertEqual(normalized["extractedFields"].get("activationChannel"), "ATM or ATB Connect")

    @unittest.skip("obsolete: runtime vision model path is disabled")
    def test_activation_channel_extracted_from_json_response(self):
        """Ollama returning JSON with activationChannel reaches extractedFields."""
        posted = {}
        ollama_json = '{"activationChannel":"ATM or ATB Connect","documentType":"card_activation_notice","summary":"Activation channel: ATM or ATB Connect."}'

        def fake_post(url, json, timeout):
            posted["json"] = json
            return FakeOllamaResponse({"response": ollama_json})

        request = VisionDocumentAnalyzeRequest(
            message="What is the activation channel in the debit card activation image?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Debit Card Activation Notice", "resourceType": "card_activation"},
        )

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.ollama_service.settings.OLLAMA_UNLOAD_AFTER_RESPONSE", False
        ), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="",
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            True,
        ):
            normalized = analyze_vision_document(request)

        self.assertIn("ATM or ATB Connect", normalized["assistantMessage"])
        self.assertEqual(normalized["extractedFields"].get("activationChannel"), "ATM or ATB Connect")
        self.assertNotIn("think", posted["json"])


class OcrFieldParserTests(unittest.TestCase):
    """Tests for generic OCR label/value parser and sufficiency check."""

    def test_label_colon_value_parsed_to_camel_case(self):
        result = _parse_ocr_fields("Activation Channel: ATM or ATB Connect\nCard Type: Debit")
        fields = result["extractedFields"]
        self.assertEqual(fields.get("activationChannel"), "ATM or ATB Connect")
        self.assertEqual(fields.get("cardType"), "Debit")

    def test_pipe_table_row_parsed(self):
        result = _parse_ocr_fields("| Status | Pending activation |")
        self.assertEqual(result["extractedFields"].get("status"), "Pending activation")

    def test_masked_value_preserved_exactly(self):
        result = _parse_ocr_fields("Card: ****4455\nExpiry: 05/29")
        fields = result["extractedFields"]
        self.assertEqual(fields.get("card"), "****4455", "masked value must be preserved")
        self.assertEqual(fields.get("expiry"), "05/29")

    def test_unknown_label_kept_in_extracted_fields(self):
        result = _parse_ocr_fields("Swift Code: ATBTTNTT\nBranch Code: 014")
        fields = result["extractedFields"]
        self.assertIn("swiftCode", fields)
        self.assertEqual(fields["swiftCode"], "ATBTTNTT")
        self.assertIn("branchCode", fields)

    def test_no_colon_label_value_parsed(self):
        """'Account ID acc_001' without colon parses to accountId='acc_001'."""
        result = _parse_ocr_fields("Account ID acc_001")
        fields = result["extractedFields"]
        self.assertEqual(
            fields.get("accountId"), "acc_001",
            f"accountId not parsed from no-colon line. Got: {fields}",
        )

    def test_iban_cert_ocr_all_fields_parsed(self):
        """Full IBAN cert OCR block (no colons) parses all known fields."""
        ocr = "\n".join([
            "Certificate ID IBAN-CERT-2026-044",
            "Customer name Omar Tentouch",
            "Account ID acc_001",
            "Branch Tunis Centre",
            "Issue date 2026-06-02",
            "Status Ready",
        ])
        result = _parse_ocr_fields(ocr)
        fields = result["extractedFields"]
        self.assertEqual(fields.get("certificateId"), "IBAN-CERT-2026-044")
        self.assertEqual(fields.get("customerName"), "Omar Tentouch")
        self.assertEqual(fields.get("accountId"), "acc_001")
        self.assertEqual(fields.get("branch"), "Tunis Centre")
        self.assertEqual(fields.get("issueDate"), "2026-06-02")
        self.assertEqual(fields.get("status"), "Ready")

    def test_generic_no_sep_queue_ticket_fields_parsed(self):
        """Generic fallback parses queue ticket 'Label Value' lines without colon."""
        ocr = "\n".join([
            "Queue number B-42",
            "Estimated wait 14 minutes",
            "Generated at 2026-06-06 10:18",
            "Status Waiting",
            "Service SME support",
        ])
        result = _parse_ocr_fields(ocr)
        fields = result["extractedFields"]
        self.assertEqual(fields.get("queueNumber"), "B-42",
                         f"queueNumber not parsed. Got: {fields}")
        self.assertEqual(fields.get("estimatedWait"), "14 minutes")
        self.assertEqual(fields.get("generatedAt"), "2026-06-06 10:18")
        self.assertEqual(fields.get("status"), "Waiting")
        self.assertEqual(fields.get("service"), "SME support")

    def test_to_camel_case_multi_word(self):
        self.assertEqual(_to_camel_case("Activation Channel"), "activationChannel")
        self.assertEqual(_to_camel_case("Notice ID"), "noticeId")
        self.assertEqual(_to_camel_case("Card Type"), "cardType")
        self.assertEqual(_to_camel_case("Recommended Step"), "recommendedStep")
        self.assertEqual(_to_camel_case("Amount"), "amount")

    def test_ocr_sufficient_specific_field_found(self):
        from app.schemas.agent import VisionDocumentAnalyzeRequest
        req = VisionDocumentAnalyzeRequest(
            message="What is the activation channel?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
        )
        ocr_fields = {"extractedFields": {"activationChannel": "ATM or ATB Connect"}, "rawFieldLabels": []}
        ok, reason = _ocr_sufficient(req, ocr_fields, "factual_question", ("activationChannel", "activation channel"))
        self.assertTrue(ok)
        self.assertIn("activationChannel", reason)

    def test_ocr_sufficient_broad_question_needs_two_fields(self):
        from app.schemas.agent import VisionDocumentAnalyzeRequest
        req = VisionDocumentAnalyzeRequest(
            message="What is shown in this image?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
        )
        # Only one field → not sufficient
        one_field = {"extractedFields": {"date": "2026-01-01"}, "rawFieldLabels": []}
        ok, reason = _ocr_sufficient(req, one_field, "factual_question", None)
        self.assertFalse(ok)

        # Two meaningful fields → sufficient
        two_fields = {"extractedFields": {"cardType": "Debit", "status": "Pending"}, "rawFieldLabels": []}
        ok2, reason2 = _ocr_sufficient(req, two_fields, "factual_question", None)
        self.assertTrue(ok2)


class OcrPipelineIntegrationTests(unittest.TestCase):
    """Integration tests for OCR-first pipeline decisions."""

    def _base_request(self, message: str, **kwargs) -> VisionDocumentAnalyzeRequest:
        return VisionDocumentAnalyzeRequest(
            message=message,
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Debit Card Activation Notice"},
            **kwargs,
        )

    def test_image_retrieval_no_ocr_no_vision(self):
        """show/open/view goal → skip OCR and vision, return metadata."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            side_effect=lambda b: (_ for _ in ()).throw(AssertionError("preprocess called")),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            side_effect=lambda b: (_ for _ in ()).throw(AssertionError("ocr called")),
        ):
            try:
                result = analyze_vision_document(self._base_request("Show me my debit card activation notice"))
                self.assertEqual(len(vision_calls), 0, "vision must not be called for retrieval")
                self.assertIn("assistantMessage", result)
            except AssertionError as exc:
                self.fail(str(exc))

    def test_specific_field_answered_from_ocr_no_vision(self):
        """OCR extracts requested field → answer returned, vision never called."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Activation Channel: ATM or ATB Connect\nCard Type: Debit",
        ):
            result = analyze_vision_document(self._base_request(
                "What is the activation channel in the debit card activation image?"
            ))

        self.assertEqual(len(vision_calls), 0, "vision must not be called when OCR is sufficient")
        self.assertEqual(result.get("source"), "ocr_extraction")
        self.assertIn("ATM or ATB Connect", result["assistantMessage"])
        self.assertEqual(result["extractedFields"].get("activationChannel"), "ATM or ATB Connect")

    def test_broad_summary_answered_from_ocr_no_vision(self):
        """OCR extracts multiple fields for broad question → no vision called."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Card Type: Debit\nExpiry: 05/29\nStatus: Pending activation\nActivation Channel: ATM or ATB Connect",
        ):
            result = analyze_vision_document(self._base_request(
                "What visual elements are shown in the debit card activation image?"
            ))

        self.assertEqual(len(vision_calls), 0, "vision must not be called when OCR has multiple fields")
        self.assertEqual(result.get("source"), "ocr_extraction")
        self.assertIn("Debit", result["assistantMessage"])
        self.assertIn("ATM or ATB Connect", result["assistantMessage"])
        self.assertIn("Pending activation", result["assistantMessage"])

    @unittest.skip("obsolete: OCR no longer falls back to vision")
    def test_sparse_ocr_triggers_vision_fallback(self):
        """OCR only extracts one weak field → vision fallback called."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": '{"activationChannel":"ATM or ATB Connect","status":"Pending","cardType":"Debit","summary":"Activation channel: ATM or ATB Connect."}'})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Date: 2026-01-01",
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            True,
        ):
            result = analyze_vision_document(self._base_request(
                "What visual elements are shown in the debit card activation image?"
            ))

        self.assertGreater(len(vision_calls), 0, "vision must be called when OCR is insufficient")
        self.assertNotEqual(result.get("source"), "ocr_extraction")

    @unittest.skip("obsolete: OCR no longer falls back to vision")
    def test_vision_structured_fields_preserved(self):
        """Vision returns multiple structured fields → all appear in result."""
        with patch("app.services.ollama_service.requests.post", return_value=FakeOllamaResponse({
            "response": '{"activationChannel":"ATM or ATB Connect","cardType":"Debit","expiry":"05/29","status":"Pending activation","summary":"Card: ****4455. Channel: ATM or ATB Connect."}'
        })), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Date: 2026-01-01",
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            True,
        ):
            result = analyze_vision_document(self._base_request(
                "What visual elements are shown in the debit card activation image?"
            ))

        fields = result.get("extractedFields") or {}
        self.assertEqual(fields.get("activationChannel"), "ATM or ATB Connect")
        self.assertEqual(fields.get("cardType"), "Debit")
        self.assertEqual(fields.get("expiry"), "05/29")
        self.assertEqual(fields.get("status"), "Pending activation")

    @unittest.skip("obsolete: OCR no longer falls back to vision")
    def test_vision_plain_text_maps_to_requested_field(self):
        """OCR misses accountId; vision returns plain 'acc_001' → extractedFields.accountId set, answer has acc_001."""
        request = VisionDocumentAnalyzeRequest(
            message="What is the account ID shown in my IBAN preview?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "IBAN Certificate Preview"},
        )

        def fake_post(url, json, timeout):
            return FakeOllamaResponse({"response": "acc_001"})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="",  # OCR unavailable
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            True,
        ):
            result = analyze_vision_document(request)

        self.assertIn("acc_001", result["assistantMessage"],
                      f"acc_001 missing from answer: {result['assistantMessage']!r}")
        self.assertNotIn("could not read clear details", result["assistantMessage"],
                         "fallback text must not appear when vision returned a value")
        self.assertEqual(result["extractedFields"].get("accountId"), "acc_001")

    @unittest.skip("obsolete: OCR no longer falls back to vision")
    def test_vision_plain_text_answer_format(self):
        """Vision plain-text injection builds 'The account ID in the ... is acc_001.' format."""
        request = VisionDocumentAnalyzeRequest(
            message="What is the account ID shown in my IBAN preview?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "IBAN Certificate Preview"},
        )

        def fake_post(url, json, timeout):
            return FakeOllamaResponse({"response": "acc_001"})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="",
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            True,
        ):
            result = analyze_vision_document(request)

        answer = result["assistantMessage"]
        self.assertIn("acc_001", answer)
        self.assertIn("account id", answer.lower().replace("**", ""))

    def test_iban_preview_account_id_answered_from_ocr_no_vision(self):
        """IBAN cert with space-separated labels: account ID answered from OCR, vision not called."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        iban_ocr = "\n".join([
            "Certificate ID IBAN-CERT-2026-044",
            "Customer name Omar Tentouch",
            "Account ID acc_001",
            "Branch Tunis Centre",
            "Issue date 2026-06-02",
            "Status Ready",
        ])

        request = VisionDocumentAnalyzeRequest(
            message="What is the account ID shown in my IBAN preview?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "IBAN Certificate"},
        )

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value=iban_ocr,
        ):
            result = analyze_vision_document(request)

        self.assertEqual(len(vision_calls), 0, "vision must not be called when OCR has account ID")
        self.assertEqual(result.get("source"), "ocr_extraction")
        self.assertIn("acc_001", result["assistantMessage"])

    def test_queue_number_answered_from_ocr_no_vision(self):
        """OCR extracts queueNumber from generic parser → answered from OCR, vision not called."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        queue_ocr = "\n".join([
            "Queue number B-42",
            "Estimated wait 14 minutes",
            "Status Waiting",
            "Service SME support",
            "Branch Lac 1",
        ])

        request = VisionDocumentAnalyzeRequest(
            message="What is my queue number in the branch queue ticket image?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Branch Queue Ticket"},
        )

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value=queue_ocr,
        ):
            result = analyze_vision_document(request)

        self.assertEqual(len(vision_calls), 0, "vision must not be called when OCR has queue number")
        self.assertEqual(result.get("source"), "ocr_extraction")
        self.assertIn("B-42", result["assistantMessage"])

    def test_queue_ticket_broad_summary_from_ocr_no_vision(self):
        """Multiple OCR fields from queue ticket → broad question answered from OCR, no vision."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        queue_ocr = "\n".join([
            "Queue number B-42",
            "Estimated wait 14 minutes",
            "Status Waiting",
            "Service SME support",
            "Branch Lac 1",
        ])

        request = VisionDocumentAnalyzeRequest(
            message="Tell me about the branch queue ticket.",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Branch Queue Ticket"},
        )

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value=queue_ocr,
        ):
            result = analyze_vision_document(request)

        self.assertEqual(len(vision_calls), 0, "vision must not be called when OCR has multiple fields")
        self.assertEqual(result.get("source"), "ocr_extraction")
        self.assertIn("B-42", result["assistantMessage"])

    def test_masked_values_preserved_in_ocr_path(self):
        """Masked card numbers from OCR must survive unchanged in extractedFields."""
        with patch("app.services.ollama_service.requests.post", side_effect=AssertionError("vision called")), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Card: ****4455\nCard Type: Debit\nExpiry: 05/29\nStatus: Pending",
        ):
            result = analyze_vision_document(self._base_request(
                "What visual elements are shown in the debit card activation image?"
            ))

        self.assertEqual(result.get("source"), "ocr_extraction")
        fields = result.get("extractedFields") or {}
        self.assertIn("****4455", str(fields.get("card") or ""), "masked card must be preserved exactly")


class ImageVisionFallbackToggleTests(unittest.TestCase):
    """Tests for ENABLE_IMAGE_VISION_FALLBACK toggle."""

    def _image_request(self, message: str, **kwargs) -> VisionDocumentAnalyzeRequest:
        return VisionDocumentAnalyzeRequest(
            message=message,
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Test Image"},
            **kwargs,
        )

    @unittest.skip("obsolete: OCR no longer falls back to vision")
    def test_toggle_true_ocr_insufficient_vision_can_be_called(self):
        """ENABLE_IMAGE_VISION_FALLBACK=true + OCR insufficient → vision fallback runs."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": '{"status":"Pending","summary":"Status: Pending."}'})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Date: 2026-01-01",  # sparse → insufficient
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            True,
        ):
            result = analyze_vision_document(self._image_request(
                "What visual elements are shown in this image?"
            ))

        self.assertGreater(len(vision_calls), 0, "vision must be called when fallback is enabled and OCR insufficient")
        self.assertNotEqual(result.get("source"), "ocr_only_fallback")

    def test_toggle_false_ocr_insufficient_vision_not_called(self):
        """ENABLE_IMAGE_VISION_FALLBACK=false + OCR insufficient → vision never called."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Date: 2026-01-01",  # sparse → insufficient
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            False,
        ):
            result = analyze_vision_document(self._image_request(
                "What visual elements are shown in this image?"
            ))

        self.assertEqual(len(vision_calls), 0, "vision must not be called when fallback is disabled")
        self.assertEqual(result.get("source"), "ocr_only_fallback")
        self.assertNotIn("hallucin", result.get("assistantMessage", "").lower())

    def test_toggle_false_ocr_sufficient_answers_from_ocr(self):
        """ENABLE_IMAGE_VISION_FALLBACK=false + OCR sufficient → OCR answer, no vision."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Queue number B-42\nStatus Waiting\nBranch Lac 1",
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            False,
        ):
            result = analyze_vision_document(self._image_request(
                "Tell me about this queue ticket."
            ))

        self.assertEqual(len(vision_calls), 0, "vision must not be called when OCR is sufficient")
        self.assertEqual(result.get("source"), "ocr_extraction")
        self.assertIn("B-42", result["assistantMessage"])

    def test_image_retrieval_no_ocr_no_vision_regardless_of_toggle(self):
        """Image retrieval (show/open goal) → no OCR and no vision regardless of toggle."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        for toggle in (True, False):
            vision_calls.clear()
            with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
                "app.services.vision_document_service._preprocess_image_bytes_for_vision",
                side_effect=AssertionError("preprocess should not run for retrieval"),
            ), patch(
                "app.services.vision_document_service._extract_ocr_text_from_image",
                side_effect=AssertionError("ocr should not run for retrieval"),
            ), patch(
                "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
                toggle,
            ):
                try:
                    result = analyze_vision_document(self._image_request(
                        "Show me my queue ticket image",
                    ))
                    self.assertEqual(len(vision_calls), 0,
                                     f"vision called for retrieval (toggle={toggle})")
                    self.assertIn("assistantMessage", result)
                except AssertionError as exc:
                    self.fail(str(exc))

    def test_toggle_false_no_ocr_fields_safe_fallback(self):
        """ENABLE_IMAGE_VISION_FALLBACK=false + zero OCR fields → safe message, no hallucination."""
        with patch("app.services.ollama_service.requests.post",
                   side_effect=AssertionError("vision must not be called")), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="",  # no OCR output at all
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            False,
        ):
            result = analyze_vision_document(self._image_request(
                "What is the queue number?"
            ))

        self.assertEqual(result.get("source"), "ocr_only_fallback")
        answer = result["assistantMessage"]
        self.assertNotIn("acc_001", answer)
        self.assertNotIn("B-42", answer)
        self.assertIn("could not", answer.lower())


class GenericOcrPipelineTests(unittest.TestCase):
    """Generic OCR-first pipeline: unknown labels, question matching, scalability."""

    # ── parser unit tests ────────────────────────────────────────────────────

    def test_unknown_multi_word_labels_parse_to_camel_case(self):
        """Completely unknown labels with varied values parse generically."""
        ocr = "\n".join([
            "Processing window Business hours",
            "Fee amount 5.000 TND",
            "Reference number REF-2026-789",
            "Loan type Personal",
            "Interest rate 8.5%",
            "Duration 36 months",
        ])
        fields = _parse_ocr_fields(ocr)["extractedFields"]
        self.assertEqual(fields.get("processingWindow"), "Business hours",
                         f"processingWindow missing. Got: {fields}")
        self.assertEqual(fields.get("feeAmount"), "5.000 TND")
        self.assertEqual(fields.get("referenceNumber"), "REF-2026-789")
        self.assertEqual(fields.get("loanType"), "Personal")
        self.assertEqual(fields.get("interestRate"), "8.5%")
        self.assertEqual(fields.get("duration"), "36 months")

    def test_unknown_image_layout_produces_non_empty_extracted_fields(self):
        """Any parseable label/value layout yields extractedFields, not empty output."""
        fields = _parse_ocr_fields(
            "Approval status Pending review\nValid until 2026-12-31\nIssued by ATB Tunis"
        )["extractedFields"]
        self.assertGreater(len(fields), 0,
                           f"extractedFields must not be empty for unknown layout. Got: {fields}")
        self.assertIn("approvalStatus", fields)
        self.assertIn("validUntil", fields)

    # ── generic question matcher unit tests ──────────────────────────────────

    def test_question_matches_unknown_two_word_field(self):
        """Two-word unknown field: question phrase normalizes to exact camelCase match."""
        extracted = {"processingWindow": "Business hours", "feeAmount": "5.000 TND"}
        match = _match_question_to_ocr_fields("What is the processing window?", extracted)
        self.assertIsNotNone(match, "should match processingWindow")
        self.assertEqual(match[0], "processingWindow")

    def test_question_matches_single_word_field(self):
        """Single content word after stopword removal matches extracted field key."""
        extracted = {"iban": "TN59001234", "branch": "Tunis Centre"}
        match = _match_question_to_ocr_fields("What is my IBAN?", extracted)
        self.assertIsNotNone(match)
        self.assertEqual(match[0], "iban")

    def test_question_no_match_returns_none(self):
        """Question with no overlap with extracted fields returns None."""
        extracted = {"processingWindow": "Business hours"}
        result = _match_question_to_ocr_fields("What is the status?", extracted)
        self.assertIsNone(result)

    # ── pipeline integration tests ────────────────────────────────────────────

    def test_unknown_field_ocr_sufficient_prevents_vision(self):
        """Unknown OCR field matched by question → OCR sufficient → vision not called."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        request = VisionDocumentAnalyzeRequest(
            message="What is the processing window?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Bank Hours Notice"},
        )

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Processing window Business hours\nFee amount 5.000 TND",
        ):
            result = analyze_vision_document(request)

        self.assertEqual(len(vision_calls), 0, "vision must not be called for unknown matched field")
        self.assertEqual(result.get("source"), "ocr_extraction")
        self.assertIn("Business hours", result["assistantMessage"])

    def test_broad_question_with_all_unknown_fields_ocr_sufficient(self):
        """2+ unknown extracted fields → broad question OCR sufficient → no vision."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        request = VisionDocumentAnalyzeRequest(
            message="What details are visible in this notice?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Bank Notice"},
        )

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Processing window Business hours\nFee amount 5.000 TND\nValid until 2026-12-31",
        ):
            result = analyze_vision_document(request)

        self.assertEqual(len(vision_calls), 0, "vision must not be called — OCR has 3 unknown fields")
        self.assertEqual(result.get("source"), "ocr_extraction")
        self.assertIn("Business hours", result["assistantMessage"])
        self.assertIn("5.000 TND", result["assistantMessage"])

    def test_requested_field_missing_vision_disabled_safe_fallback(self):
        """Known single-field query, OCR missing it, toggle false → ocr_only_fallback with OCR context."""
        request = VisionDocumentAnalyzeRequest(
            message="What is the status of my request?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Bank Notice"},
        )

        with patch("app.services.ollama_service.requests.post",
                   side_effect=AssertionError("vision must not be called")), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("base64data", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Processing window Business hours\nFee amount 5.000 TND",
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            False,
        ):
            result = analyze_vision_document(request)

        self.assertEqual(result.get("source"), "ocr_only_fallback")
        answer = result["assistantMessage"]
        self.assertNotIn("approved", answer.lower())
        self.assertNotIn("rejected", answer.lower())
        self.assertIn("Business hours", answer)


class RobustOcrTests(unittest.TestCase):
    """Pipeline works for any readable screenshot or image, not only banking documents."""

    # ── _search_answer_in_raw_text unit tests ────────────────────────────────

    def test_raw_text_search_no_separator(self):
        """`field label value` on one line → raw text search extracts value."""
        ocr = "Queue number B-42\nEstimated wait 14 minutes"
        self.assertEqual(_search_answer_in_raw_text(ocr, "queue number"), "B-42")

    def test_raw_text_search_preserves_numeric_value_exactly(self):
        """Numeric value with decimal and currency preserved exactly."""
        ocr = "Fee amount 7.000 TND"
        self.assertEqual(_search_answer_in_raw_text(ocr, "fee amount"), "7.000 TND")

    def test_raw_text_search_colon_separator(self):
        """Colon-separated `label: value` also matched by raw text search."""
        ocr = "Transaction reference: TXN-2026-001\nDate: 2026-06-11"
        self.assertEqual(_search_answer_in_raw_text(ocr, "transaction reference"), "TXN-2026-001")

    def test_raw_text_search_returns_none_when_not_found(self):
        """Returns None when field label not present in raw text."""
        ocr = "Queue number B-42\nEstimated wait 14 minutes"
        self.assertIsNone(_search_answer_in_raw_text(ocr, "account id"))

    # ── pipeline integration: specific-field via raw text search ─────────────

    def test_raw_text_path_answers_when_parsing_finds_nothing(self):
        """Raw text search provides answer when _parse_ocr_fields finds no matching field.

        Forces empty parsed fields to isolate the raw-text-search fallback path.
        """
        request = VisionDocumentAnalyzeRequest(
            message="What is my queue number?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Queue Ticket"},
        )
        ocr = "Queue number B-42\nEstimated wait 14 minutes"

        with patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("b64", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value=ocr,
        ), patch(
            "app.services.vision_document_service._parse_ocr_fields",
            return_value={"extractedFields": {}, "rawFieldLabels": []},
        ), patch(
            "app.services.ollama_service.requests.post",
            side_effect=AssertionError("vision must not be called"),
        ):
            result = analyze_vision_document(request)

        self.assertEqual(result["source"], "ocr_extraction",
                         f"Raw text search should make OCR sufficient. Got: {result.get('source')}")
        self.assertIn("B-42", result["assistantMessage"])

    # ── pipeline integration: broad question from paragraph text ─────────────

    def test_plain_paragraph_image_answers_broad_question(self):
        """Image with mixed text (some labels, some prose) → broad question answered from OCR.

        Uses 'What information is in this image?' (goal=detail_question) to avoid
        the show_document short-circuit triggered by messages containing 'show'.
        """
        request = VisionDocumentAnalyzeRequest(
            message="What information is in this image?",
            userRole="CLIENT",
            mimeType="image/png",
            pdfBase64="aW1hZ2U=",
        )
        paragraph = "Your appointment is confirmed\nDate: Monday June 15\nTime: 10:00 AM\nBring your ID"

        with patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("b64", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value=paragraph,
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            False,
        ):
            result = analyze_vision_document(request)

        self.assertIn(result["source"], {"ocr_extraction", "ocr_only_fallback"})
        answer = result["assistantMessage"]
        self.assertNotIn("could not read", answer.lower())
        self.assertTrue(
            "confirmed" in answer.lower() or "appointment" in answer.lower()
            or "10:00" in answer or "june" in answer.lower()
            or "monday" in answer.lower(),
            f"Answer must mention appointment content. Got: {answer}",
        )

    # ── unknown documentType doesn't block OCR path ──────────────────────────

    def test_unknown_document_type_does_not_block_ocr(self):
        """No documentType hint in resourceJson → OCR path still works normally."""
        request = VisionDocumentAnalyzeRequest(
            message="What is the amount?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Unknown doc"},
        )
        ocr = "Amount: 150.000 TND\nDate: 2026-06-11"

        with patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("b64", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value=ocr,
        ), patch(
            "app.services.ollama_service.requests.post",
            side_effect=AssertionError("vision must not be called"),
        ):
            result = analyze_vision_document(request)

        self.assertEqual(result["source"], "ocr_extraction")
        self.assertIn("150.000", result["assistantMessage"])

    # ── original image OCR preferred when it has more content ────────────────

    def test_original_image_ocr_preferred_over_preprocessed_when_richer(self):
        """When original-bytes OCR yields more lines than preprocessed, original wins."""
        request = VisionDocumentAnalyzeRequest(
            message="What is the amount?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
        )

        def fake_ocr(img_bytes):
            if img_bytes == b"image":  # base64.b64decode("aW1hZ2U=") == b"image"
                return "Amount: 42.000 TND\nDate: 2026-06-11\nStatus: Completed"
            return "Amount 42"  # preprocessed has less content

        with patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("b64", b"processed-img"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            side_effect=fake_ocr,
        ), patch(
            "app.services.ollama_service.requests.post",
            side_effect=AssertionError("vision must not be called"),
        ):
            result = analyze_vision_document(request)

        self.assertEqual(result["source"], "ocr_extraction")
        self.assertIn("42.000", result["assistantMessage"])

    # ── OCR text found prevents "could not read clearly" ─────────────────────

    def test_ocr_text_found_prevents_could_not_read_message(self):
        """Any OCR text → never return 'could not read clearly', even when vision disabled."""
        request = VisionDocumentAnalyzeRequest(
            message="What does this say?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
        )
        ocr = "Welcome to ATB Branches\nOpen from 8am to 5pm"

        with patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("b64", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value=ocr,
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            False,
        ):
            result = analyze_vision_document(request)

        self.assertNotIn("could not read", result["assistantMessage"].lower())

    # ── vision-fallback toggle ────────────────────────────────────────────────

    def test_vision_fallback_disabled_never_calls_vision_even_when_ocr_empty(self):
        """ENABLE_IMAGE_VISION_FALLBACK=false → zero vision calls regardless of OCR."""
        vision_calls = []

        def fake_post(url, json, timeout):
            vision_calls.append(url)
            return FakeOllamaResponse({"response": "should not be called"})

        request = VisionDocumentAnalyzeRequest(
            message="What is my IBAN?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
        )

        with patch("app.services.ollama_service.requests.post", side_effect=fake_post), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("b64", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="",
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            False,
        ):
            result = analyze_vision_document(request)

        self.assertEqual(len(vision_calls), 0, "no vision calls when fallback disabled")
        self.assertIn(result["source"], {"ocr_extraction", "ocr_only_fallback"})

    def test_vision_called_only_when_ocr_lacks_requested_field(self):
        """ENABLE_IMAGE_VISION_FALLBACK=true → vision fires only when OCR can't answer."""
        vision_calls = []
        request = VisionDocumentAnalyzeRequest(
            message="What is the amount?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
        )

        # OCR has 'amount' field → should NOT call vision
        with patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("b64", b"imgbytes"),
        ), patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value="Amount: 42.000 TND\nDate: 2026-06-11",
        ), patch(
            "app.services.vision_document_service.settings.ENABLE_IMAGE_VISION_FALLBACK",
            True,
        ), patch(
            "app.services.ollama_service.requests.post",
            side_effect=lambda *a, **kw: vision_calls.append(a) or FakeOllamaResponse({"response": "{}"}),
        ):
            result = analyze_vision_document(request)

        self.assertEqual(len(vision_calls), 0, "vision must not fire when OCR has the field")
        self.assertEqual(result["source"], "ocr_extraction")
        self.assertIn("42.000", result["assistantMessage"])


class VisionApiLevelTests(unittest.TestCase):
    """End-to-end service-layer tests equivalent to POST /agent/analyze-vision-document."""

    def test_api_level_queue_ticket_image_returns_ocr_extraction(self):
        """Full pipeline: image/jpeg with queue-ticket OCR text → ocr_extraction, no vision."""
        request = VisionDocumentAnalyzeRequest(
            message="What is my queue number?",
            userRole="CLIENT",
            mimeType="image/jpeg",
            pdfBase64="aW1hZ2U=",
            resourceJson={"title": "Queue Ticket"},
        )
        ocr_text = "Queue number B-42\nEstimated wait 14 minutes\nService ATB Counter"

        with patch(
            "app.services.vision_document_service._extract_ocr_text_from_image",
            return_value=ocr_text,
        ), patch(
            "app.services.vision_document_service._preprocess_image_bytes_for_vision",
            return_value=("b64dummy", b"imgbytes"),
        ), patch(
            "app.services.ollama_service.requests.post",
            side_effect=AssertionError("vision (qwen3-vl) must not be called when OCR succeeds"),
        ):
            result = analyze_vision_document(request)

        # source: OCR path
        self.assertEqual(result["source"], "ocr_extraction",
                         f"Expected ocr_extraction. Got: {result.get('source')}")
        # extractedFields populated
        ef = result.get("extractedFields") or {}
        self.assertIn("queueNumber", ef,
                      f"extractedFields must contain queueNumber. Got: {ef}")
        self.assertEqual(ef["queueNumber"], "B-42")
        # assistantMessage answers the question
        self.assertIn("B-42", result["assistantMessage"],
                      f"assistantMessage must include B-42. Got: {result.get('assistantMessage')}")


class MaskedValueOcrRepairTests(unittest.TestCase):
    """Regression tests for masked banking-value OCR repair (_looks_like_garbled_masked,
    _salvage_masked_value).  Ensures card numbers like '****4455' and garbled reads
    like 'A AB 5B' are handled correctly without touching non-masked fields."""

    def _garbled(self, v):
        from app.services.vision_document_service import _looks_like_garbled_masked
        return _looks_like_garbled_masked(v)

    def _salvage(self, orig, reocr):
        from app.services.vision_document_service import _salvage_masked_value
        return _salvage_masked_value(orig, reocr)

    # --- garbled detection ---

    def test_garbled_detected_typical_noise(self):
        self.assertTrue(self._garbled("A AB 5B"))

    def test_garbled_detected_alternating_letter_digit(self):
        self.assertTrue(self._garbled("X7 B3 5A"))

    def test_garbled_detected_no_digits(self):
        self.assertTrue(self._garbled("ABxx CD"))

    def test_garbled_detected_empty(self):
        self.assertTrue(self._garbled(""))

    def test_garbled_not_triggered_for_stars_and_digits(self):
        self.assertFalse(self._garbled("****4455"))

    def test_garbled_not_triggered_for_grouped_mask(self):
        self.assertFalse(self._garbled("**** **** **** 4455"))

    def test_garbled_not_triggered_for_plain_digits(self):
        self.assertFalse(self._garbled("4455"))

    def test_garbled_not_triggered_for_iban(self):
        self.assertFalse(self._garbled("TN59 1234 5678 9012"))

    def test_garbled_not_triggered_for_amount_with_currency(self):
        self.assertFalse(self._garbled("18.500 TND"))

    def test_garbled_not_triggered_for_queue_id(self):
        self.assertFalse(self._garbled("B-42"))

    # --- suffix salvage ---

    def test_salvage_from_reocr_with_suffix(self):
        """Re-OCR provides clean suffix → salvage returns value containing it."""
        result = self._salvage("A AB 5B", "***4455")
        self.assertIn("4455", result)

    def test_salvage_from_reocr_grouped_mask(self):
        result = self._salvage("A AB 5B", "**** **** **** 4455")
        self.assertIn("4455", result)

    def test_salvage_from_original_digits(self):
        """When re-OCR is empty, extract trailing digits from original."""
        result = self._salvage("X5 AB 4455", "")
        self.assertIn("4455", result)

    def test_salvage_no_digits_returns_original(self):
        """If neither original nor re-OCR has enough digits, return original unchanged."""
        result = self._salvage("A AB BC", "")
        self.assertEqual(result, "A AB BC")

    def test_salvage_formats_as_masked_card(self):
        """4+ digit suffix gets '****' prefix."""
        result = self._salvage("A AB 5B", "4455")
        self.assertIn("4455", result)


if __name__ == "__main__":
    unittest.main()
