import sys
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.modules.setdefault("fitz", types.ModuleType("fitz"))

from app.services.vision_document_service import (  # noqa: E402
    _clean_technical_markdown,
    _normalize_result,
)


class VisionMarkdownCleanupTests(unittest.TestCase):
    def test_removes_not_real_document_disclaimer_but_keeps_download_text(self):
        markdown = (
            "## Payment Receipt\n\n"
            "It is not a real banking document. "
            "You can download the PDF to view the details.\n\n"
            "| Field | Details |\n"
            "| --- | --- |\n"
            "| Amount | **42.000 TND** |"
        )

        cleaned = _clean_technical_markdown(markdown)

        self.assertNotIn("not a real banking document", cleaned.lower())
        self.assertIn("You can download the PDF to view the details.", cleaned)
        self.assertIn("**42.000 TND**", cleaned)

    def test_removes_demo_disclaimers_from_markdown_and_warnings(self):
        result = _normalize_result(
            {
                "markdown": (
                    "This synthetic demo resource is for testing only.\n\n"
                    "The receipt amount is **75.500 TND**."
                ),
                "warnings": [
                    "This is a synthetic demo resource, not a real transaction.",
                    "The total amount is partially cropped.",
                ],
            }
        )

        self.assertNotIn("synthetic", result["assistantMessage"].lower())
        self.assertNotIn("demo", result["assistantMessage"].lower())
        self.assertIn("**75.500 TND**", result["assistantMessage"])
        self.assertEqual(result["warnings"], ["The total amount is partially cropped."])


if __name__ == "__main__":
    unittest.main()
