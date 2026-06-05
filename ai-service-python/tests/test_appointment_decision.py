import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import settings
from app.schemas.agent import AgentAnalyzeRequest, AgentContext, AvailableAction, ResolvedResourceContext
from app.services.decision_service import decide_message
from app.services.intent_service import analyze_message


settings.USE_OLLAMA = False


AVAILABLE_ACTIONS = [
    AvailableAction(
        name="book_appointment",
        riskLevel="medium",
        requiredFields=["branch", "date", "time"],
    ),
]

ATB_CONNECT_RESOURCE = {
    "resourceType": "digital_banking_guide",
    "title": "ATB Connect Activation Guide",
    "serviceName": "ATB Connect",
    "documentType": "Activation guide",
    "activationChannel": "Branch or online onboarding",
    "requiredId": "CIN or passport",
    "supportChannel": "Digital banking support",
    "status": "Available",
}


def request(message, **kwargs):
    return AgentAnalyzeRequest(
        message=message,
        userRole="client",
        availableActions=AVAILABLE_ACTIONS,
        **kwargs,
    )


def atb_connect_request(message):
    return request(
        message,
        resolvedResourceContext=ResolvedResourceContext(
            resourceJson=ATB_CONNECT_RESOURCE,
            fileUrl="http://localhost/atb-general-resources/documents/03_atb_connect_activation_guide.pdf",
            extractionStatus="metadata_only",
        ),
    )


class AppointmentDecisionTests(unittest.TestCase):
    def test_card_pickup_appointment_is_resource_lookup(self):
        decision = decide_message(request("Do I have a card pickup appointment?"))

        self.assertEqual(decision["decision"], "search_resource")
        self.assertEqual(decision["intent"], "appointment_lookup")
        self.assertEqual(decision["resourceQuery"], "card pickup appointment")
        self.assertIsNone(decision["action"])

    def test_confirmed_branch_appointment_is_resource_lookup(self):
        decision = decide_message(request("Do I have a confirmed branch appointment?"))

        self.assertEqual(decision["decision"], "search_resource")
        self.assertEqual(decision["intent"], "appointment_lookup")
        self.assertEqual(decision["resourceQuery"], "confirmed branch appointment")
        self.assertIsNone(decision["action"])

    def test_explicit_booking_starts_booking_flow(self):
        decision = decide_message(request("Book an appointment at Tunis Centre."))

        self.assertEqual(decision["decision"], "prepare_action")
        self.assertEqual(decision["action"], "book_appointment")
        self.assertEqual(decision["fields"]["branch"], "Tunis Centre")
        self.assertEqual(decision["missingFields"], ["date", "time"])

    def test_explicit_schedule_meeting_starts_booking_flow(self):
        decision = decide_message(request("Schedule a meeting with an advisor."))

        self.assertEqual(decision["decision"], "prepare_action")
        self.assertEqual(decision["action"], "book_appointment")

    def test_branch_name_after_lookup_is_not_booking_without_pending_action(self):
        decision = decide_message(request("Tunis Centre"))

        self.assertNotEqual(decision["decision"], "prepare_action")
        self.assertIsNone(decision["action"])

    def test_broad_card_request_is_resource_search(self):
        decision = decide_message(request("Find anything related to my card."))

        self.assertEqual(decision["decision"], "search_resource")
        self.assertEqual(decision["intent"], "broad_resource_search")
        self.assertEqual(decision["resourceQuery"], "card")

    def test_specific_card_pickup_appointment_resource_is_not_broad_search(self):
        decision = decide_message(request("Show me the appointment resource related to card pickup."))

        self.assertEqual(decision["decision"], "search_resource")
        self.assertNotEqual(decision["intent"], "broad_resource_search")
        self.assertEqual(decision["resourceQuery"], "card pickup appointment")

    def test_broad_payment_request_is_resource_search(self):
        decision = decide_message(request("Find anything related to payments."))

        self.assertEqual(decision["decision"], "search_resource")
        self.assertEqual(decision["intent"], "broad_resource_search")
        self.assertEqual(decision["resourceQuery"], "payments")

    def test_broad_appointment_request_is_resource_search(self):
        decision = decide_message(request("Find anything related to appointments."))

        self.assertEqual(decision["decision"], "search_resource")
        self.assertEqual(decision["intent"], "broad_resource_search")
        self.assertEqual(decision["resourceQuery"], "appointments")

    def test_broad_document_request_is_resource_search(self):
        decision = decide_message(request("Find anything related to documents."))

        self.assertEqual(decision["decision"], "search_resource")
        self.assertEqual(decision["intent"], "broad_resource_search")
        self.assertEqual(decision["resourceQuery"], "documents")

    def test_card_replacement_button_prompt_resolves_resource_lookup(self):
        decision = decide_message(
            request("What is the status of my debit card replacement request?")
        )

        self.assertEqual(decision["decision"], "search_resource")
        self.assertIsNone(decision["action"])

    def test_card_replacement_button_label_resolves_resource_lookup(self):
        decision = decide_message(request("Card replacement"))

        self.assertEqual(decision["decision"], "search_resource")
        self.assertEqual(decision["resourceQuery"], "debit card replacement request")
        self.assertIsNone(decision["action"])

    def test_appointment_confirmation_answer_includes_details(self):
        analysis = analyze_message(
            request(
                "Do I have a card pickup appointment?",
                resolvedResourceContext=ResolvedResourceContext(
                    resourceJson={
                        "resourceType": "appointment_confirmation",
                        "title": "Card Pickup Appointment Confirmation",
                        "status": "Confirmed",
                        "branch": "Tunis Centre",
                        "date": "2026-05-29",
                        "time": "10:00",
                        "advisor": "Ms. Ben Ali",
                        "reference": "APT-DEMO-2026-000123",
                    },
                    extractionStatus="metadata_only",
                ),
            )
        )

        self.assertEqual(analysis["agentMode"], "file_analysis")
        self.assertIsNone(analysis["actionName"])
        self.assertNotIn("| Field |", analysis["assistantMessage"])
        self.assertIn("**confirmed**", analysis["assistantMessage"])
        for expected in [
            "Tunis Centre",
            "2026-05-29",
            "10:00",
            "Ms. Ben Ali",
            "APT-DEMO-2026-000123",
        ]:
            self.assertIn(expected, analysis["assistantMessage"])

    def test_debit_card_replacement_status_is_natural_text(self):
        analysis = analyze_message(
            request(
                "What is the status of my debit card replacement request?",
                resolvedResourceContext=ResolvedResourceContext(
                    resourceJson={
                        "resourceType": "card_service_request",
                        "title": "Debit Card Replacement Request",
                        "requestId": "CARD-REP-2026-031",
                        "card": "************9011",
                        "reason": "Lost card",
                        "requestedBranch": "Tunis Centre",
                        "fee": "12.000 TND",
                        "status": "Ready for confirmation",
                    },
                    extractionStatus="metadata_only",
                ),
            )
        )

        self.assertNotIn("| Field |", analysis["assistantMessage"])
        self.assertIn("**ready for confirmation**", analysis["assistantMessage"])
        self.assertIn("**CARD-REP-2026-031**", analysis["assistantMessage"])

    def test_credit_card_limit_is_natural_text(self):
        analysis = analyze_message(
            request(
                "What is my credit card limit?",
                resolvedResourceContext=ResolvedResourceContext(
                    resourceJson={
                        "resourceType": "card_limit_notice",
                        "title": "Credit Card Limit Notice",
                        "card": "************1122",
                        "currentLimit": "2500.000 TND",
                        "availableLimit": "1735.250 TND",
                        "paymentDueDate": "2026-06-10",
                    },
                    extractionStatus="metadata_only",
                ),
            )
        )

        self.assertNotIn("| Field |", analysis["assistantMessage"])
        self.assertIn("**2500.000 TND**", analysis["assistantMessage"])
        self.assertIn("**1735.250 TND**", analysis["assistantMessage"])

    def test_branch_directory_keeps_table(self):
        analysis = analyze_message(
            request(
                "What branches are available in Tunis?",
                resolvedResourceContext=ResolvedResourceContext(
                    resourceJson={
                        "resourceType": "branch_directory",
                        "title": "Tunis Branch Directory",
                        "branches": [
                            {
                                "name": "Tunis Centre",
                                "address": "Avenue Habib Bourguiba",
                                "hours": "08:30-16:30",
                                "services": "Accounts, cards",
                            }
                        ],
                    },
                    extractionStatus="metadata_only",
                ),
            )
        )

        self.assertIn("| Branch | Address | Hours | Services |", analysis["assistantMessage"])

    def test_atb_connect_summary_respects_summarize_intent(self):
        analysis = analyze_message(
            atb_connect_request("Summarize the latest resource related to ATB Connect.")
        )

        self.assertIn(
            "I found the latest ATB Connect resource: **ATB Connect Activation Guide**.",
            analysis["assistantMessage"],
        )
        self.assertIn("This resource explains", analysis["assistantMessage"])
        self.assertIn("Key points:", analysis["assistantMessage"])
        self.assertIn("Required ID: **CIN or passport**", analysis["assistantMessage"])
        self.assertNotIn("Here is how to activate", analysis["assistantMessage"])
        self.assertTrue(analysis["toolInput"].get("quickActions"))

    def test_atb_connect_how_to_gives_steps(self):
        analysis = analyze_message(atb_connect_request("How do I activate ATB Connect?"))

        self.assertIn("Here is how to activate **ATB Connect**.", analysis["assistantMessage"])
        self.assertIn("1.", analysis["assistantMessage"])
        self.assertIn("**CIN or passport**", analysis["assistantMessage"])
        self.assertTrue(analysis["toolInput"].get("quickActions"))

    def test_atb_connect_open_guide_is_document_response(self):
        analysis = analyze_message(atb_connect_request("Open the ATB Connect guide."))

        self.assertIn("I found the ATB Connect guide", analysis["assistantMessage"])
        self.assertIn("**ATB Connect Activation Guide**", analysis["assistantMessage"])
        self.assertIn("Download PDF", analysis["assistantMessage"])
        self.assertTrue(analysis["toolInput"].get("quickActions"))

    def test_atb_connect_id_question_is_direct_answer(self):
        analysis = analyze_message(
            atb_connect_request("What ID do I need for ATB Connect activation?")
        )

        self.assertEqual(
            analysis["assistantMessage"],
            "For ATB Connect activation, you need **CIN or passport**.",
        )
        self.assertFalse(analysis["toolInput"].get("quickActions"))

    def test_customer_profile_overview_uses_generic_resource_fields(self):
        analysis = analyze_message(
            request(
                "Show me my customer profile overview.",
                resolvedResourceContext=ResolvedResourceContext(
                    resourceJson={
                        "resourceType": "customer_profile",
                        "title": "Customer Profile Overview",
                        "category": "customer_profile",
                        "fields": {
                            "fullName": "Omar Tentouch",
                            "segment": "Student / Young Professional",
                            "primaryBranch": "Tunis Centre",
                            "relationshipStartDate": "2024-09-12",
                            "riskLevel": "Standard",
                            "preferredLanguage": "French / English",
                        },
                    },
                    fileUrl="http://localhost/atb-general-resources/documents/customer_profile_overview.pdf",
                    extractionStatus="metadata_only",
                ),
            )
        )

        message = analysis["assistantMessage"]
        self.assertIn("Customer Profile Overview", message)
        self.assertNotEqual(message.strip(), "Category: customer_profile")
        self.assertNotIn("Category: **customer_profile**", message)
        self.assertGreaterEqual(message.count("\n- "), 4)
        for expected in [
            "Full name: **Omar Tentouch**",
            "Segment: **Student / Young Professional**",
            "Primary branch: **Tunis Centre**",
            "Risk level: **Standard**",
        ]:
            self.assertIn(expected, message)

    def test_credit_card_limit_notice_uses_nested_generic_fields(self):
        analysis = analyze_message(
            request(
                "Show me my credit card limit notice.",
                resolvedResourceContext=ResolvedResourceContext(
                    resourceJson={
                        "resourceType": "card_limit_notice",
                        "title": "Credit Card Limit Notice",
                        "extractedFields": {
                            "currentLimit": "2500.000 TND",
                            "availableLimit": "1735.250 TND",
                            "paymentDueDate": "2026-06-10",
                        },
                    },
                    fileUrl="http://localhost/atb-general-resources/documents/credit_card_limit_notice.pdf",
                    extractionStatus="metadata_only",
                ),
            )
        )

        message = analysis["assistantMessage"]
        self.assertIn("Current limit: **2500.000 TND**", message)
        self.assertIn("Available limit: **1735.250 TND**", message)
        self.assertIn("Payment due date: **2026-06-10**", message)

    def test_file_url_resource_has_download_pdf_action_for_document_request(self):
        analysis = analyze_message(
            request(
                "Display my policy document.",
                resolvedResourceContext=ResolvedResourceContext(
                    resourceJson={
                        "resourceType": "future_policy_notice",
                        "title": "Future Policy Notice",
                        "data": {
                            "policyId": "POL-2026-001",
                            "status": "Active",
                        },
                    },
                    fileUrl="http://localhost/atb-general-resources/documents/future_policy_notice.pdf",
                    extractionStatus="metadata_only",
                ),
            )
        )

        actions = analysis["toolInput"].get("quickActions") or []
        self.assertTrue(any(action.get("label") == "Download PDF" for action in actions))
        self.assertNotIn("http://localhost/atb-general-resources", analysis["assistantMessage"])

    def test_general_natural_chat_does_not_include_download_pdf(self):
        analysis = analyze_message(
            AgentAnalyzeRequest(
                message="What is a loan?",
                userRole="client",
                availableActions=[],
                agentContext=AgentContext(
                    generalNaturalChat={
                        "resourceFound": False,
                        "originalUserQuestion": "What is a loan?",
                    },
                ),
            )
        )

        self.assertEqual(analysis["intent"], "general_natural_chat")
        self.assertNotIn("Download PDF", analysis["assistantMessage"])
        self.assertFalse(analysis["toolInput"].get("quickActions"))

    def test_security_notice_recommendation_is_resource_question_answer(self):
        analysis = analyze_message(
            request(
                "What does the mobile banking security notice recommend?",
                resolvedResourceContext=ResolvedResourceContext(
                    resourceJson={
                        "resourceType": "security_notice",
                        "title": "Mobile Banking Security Notice",
                        "recommendations": [
                            "Never share OTP or SMS codes",
                            "Use only the official bank app",
                            "Avoid suspicious links",
                        ],
                    },
                    fileUrl="http://localhost/atb-general-resources/documents/mobile_banking_security_notice.pdf",
                    extractionStatus="metadata_only",
                ),
            )
        )

        self.assertIn("mobile banking security notice recommends", analysis["assistantMessage"])
        self.assertIn("Never share OTP", analysis["assistantMessage"])
        self.assertFalse(analysis["toolInput"].get("quickActions"))


if __name__ == "__main__":
    unittest.main()
