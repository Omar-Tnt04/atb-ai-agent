import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import settings
from app.schemas.agent import AgentAnalyzeRequest, AgentContext
from app.services.intent_service import analyze_message


settings.USE_OLLAMA = False


def request(message):
    return AgentAnalyzeRequest(
        message=message,
        userRole="client",
        availableActions=[],
    )


def natural_request(message):
    return AgentAnalyzeRequest(
        message=message,
        userRole="client",
        availableActions=[],
        agentContext=AgentContext(
            systemInstruction=(
                "You are a helpful banking assistant. Answer the user's natural question directly and concisely. "
                "Do not claim you found a server document unless the backend provided one."
            ),
            generalNaturalChat={
                "resourceFound": False,
                "originalUserQuestion": message,
            },
        ),
    )


class GeneralBankingFallbackTests(unittest.TestCase):
    def test_rib_certificate_question_gets_direct_general_answer(self):
        analysis = analyze_message(request("What is a RIB certificate?"))

        self.assertEqual(analysis["agentMode"], "informational_answer")
        self.assertIn("identifies a bank account", analysis["assistantMessage"])
        self.assertIn("account holder name", analysis["assistantMessage"])
        self.assertIn("RIB or IBAN", analysis["assistantMessage"])
        self.assertNotIn("I can help with banking services", analysis["assistantMessage"])

    def test_capabilities_question_still_gets_capabilities_message(self):
        analysis = analyze_message(request("Hello, what can you do?"))

        self.assertIn("I can help with banking services", analysis["assistantMessage"])
        self.assertIn("accounts", analysis["assistantMessage"])
        self.assertIn("transfers", analysis["assistantMessage"])

    def test_general_natural_chat_examples_answer_directly(self):
        examples = [
            ("What is a loan?", "money a bank or lender provides"),
            ("How does a credit card work?", "approved credit limit"),
            ("What should I do if I lost my card?", "block it immediately"),
            ("How can I avoid mobile banking scams?", "never share OTP"),
            ("Can you explain interest rates simply?", "price of borrowing money"),
            ("What documents are usually needed for a loan?", "proof of income"),
        ]

        for message, expected in examples:
            with self.subTest(message=message):
                analysis = analyze_message(natural_request(message))
                self.assertEqual(analysis["intent"], "general_natural_chat")
                self.assertEqual(analysis["toolInput"]["modelMode"], "text")
                self.assertIn(expected, analysis["assistantMessage"])
                self.assertNotIn("I can help with banking services", analysis["assistantMessage"])


if __name__ == "__main__":
    unittest.main()
