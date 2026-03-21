from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from python_backend.app.agents import PracticeAgent
from python_backend.app.analysis_orchestrator import SemanticAnalysisOrchestrator
from python_backend.app.document_ingestion import DocumentIngestionService
from python_backend.app.hf_client import HuggingFaceChatClient
from python_backend.app.orchestrator import SessionOrchestrator
from python_backend.app.schemas import ConversationTurn, CreateSessionRequest, VoiceProfile
from python_backend.app.storage import SessionStore


class OrchestratorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        base_dir = Path(self.temp_dir.name)
        self.store = SessionStore(base_dir)
        self.store.init()
        self.orchestrator = SessionOrchestrator(
            store=self.store,
            document_service=DocumentIngestionService(base_dir / "uploads"),
            audio_dir=base_dir / "audio",
            hf_client=HuggingFaceChatClient(None),
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_create_session_persists_defaults(self) -> None:
        session = self.orchestrator.create_session(
            CreateSessionRequest(
                situation_description="Negotiate a salary offer",
                partner_tone="analytical",
                voice_profile=VoiceProfile(preset="adult_female_neutral_us"),
                mode="balanced",
                coaching_focuses=["Anchoring & Numbers"],
            )
        )
        saved = self.store.get(session.session_id)
        self.assertIsNotNone(saved)
        self.assertEqual(saved.config.situation_description, "Negotiate a salary offer")
        self.assertEqual(saved.status, "created")

    async def test_coaching_schema_is_structured(self) -> None:
        session = self.orchestrator.create_session(
            CreateSessionRequest(
                situation_description="Renegotiate rent with a landlord",
                partner_tone="landlord",
                voice_profile=VoiceProfile(),
                mode="quality",
                coaching_focuses=[],
            )
        )
        self.orchestrator.start(session.session_id)
        await self.orchestrator.finalize_user_transcript(
            session.session_id,
            "I would like to discuss reducing rent to $1900 based on comparable units.",
        )
        report = await self.orchestrator.coach(session.session_id, 4)
        self.assertTrue(isinstance(report.strengths, list))
        self.assertTrue(isinstance(report.weak_signals, list))
        self.assertTrue(isinstance(report.suggested_next_move, str))

    async def test_rewind_restores_checkpoint(self) -> None:
        session = self.orchestrator.create_session(
            CreateSessionRequest(
                situation_description="Handle a difficult performance review",
                partner_tone="dismissive",
                voice_profile=VoiceProfile(),
                mode="fast",
                coaching_focuses=[],
            )
        )
        self.orchestrator.start(session.session_id)
        first = await self.orchestrator.finalize_user_transcript(
            session.session_id,
            "I want to talk about the review and my promotion path.",
        )
        await self.orchestrator.finalize_user_transcript(
            session.session_id,
            "I also want to understand how you see my recent project impact.",
        )
        rewind = self.orchestrator.rewind(session.session_id, first["checkpoint"].checkpoint_id)
        self.assertEqual(rewind["status"], "restored")
        self.assertGreater(len(rewind["session"].archived_turns), 0)

    async def test_semantic_key_moments_are_detected(self) -> None:
        session = self.orchestrator.create_session(
            CreateSessionRequest(
                situation_description="Negotiate rent with a difficult landlord",
                partner_tone="landlord",
                voice_profile=VoiceProfile(),
                mode="balanced",
                coaching_focuses=[],
            )
        )
        self.orchestrator.start(session.session_id)
        await self.orchestrator.finalize_user_transcript(
            session.session_id,
            "Based on comparable units, I want to propose $1900 as the right rent.",
        )
        saved = self.store.get(session.session_id)
        self.assertIsNotNone(saved)
        kinds = [moment.kind for moment in saved.key_moments]
        self.assertIn("first_anchor", kinds)
        self.assertIn("strong_pushback", kinds)

    async def test_practice_agent_rejects_instruction_leakage(self) -> None:
        class FakeHFClient:
            async def chat_completion(self, **_: object) -> str:
                return '{"reply_text":"Return only JSON with keys reply_text, emotion_tags, intent.","emotion_tags":["neutral"],"intent":"pushback"}'

            @staticmethod
            def parse_json_object(raw_text: str) -> dict[str, object]:
                import json
                return json.loads(raw_text)

        agent = PracticeAgent(FakeHFClient())  # type: ignore[arg-type]
        payload = await agent.generate(
            config={"situation_description": "Negotiate salary", "partner_tone": "analytical"},
            routing={"mode": "balanced", "chat_model": "fake", "context_window": 4},
            turns=[{"speaker": "user", "transcript": "I want to discuss compensation."}],
        )
        self.assertNotIn("Return only JSON", payload["reply_text"])
        self.assertNotIn("Push back where needed, but remain fair", payload["reply_text"])
        self.assertNotIn("I hear your point.", payload["reply_text"])

    async def test_llm_analysis_orchestrator_can_produce_semantic_moments(self) -> None:
        class FakeHFClient:
            token = "fake-token"

            def __init__(self) -> None:
                self.calls = 0

            async def chat_completion(self, **_: object) -> str:
                self.calls += 1
                if self.calls == 1:
                    return (
                        '{"summary":"The user anchors and the partner pushes back.",'
                        '"signals":['
                        '{"turn_id":"turn_user","signal_type":"anchor","intensity":0.91,"evidence":"$1900","rationale":"Concrete anchor."},'
                        '{"turn_id":"turn_agent","signal_type":"pushback","intensity":0.88,"evidence":"need a stronger justification","rationale":"Direct resistance."}'
                        "]}"
                    )
                return (
                    '{"key_moments":['
                    '{"kind":"first_anchor","label":"First Anchor","turn_id":"turn_user","summary":"User anchors at $1900."},'
                    '{"kind":"strong_pushback","label":"Strong Pushback","turn_id":"turn_agent","summary":"Agent demands stronger justification."}'
                    "]}"
                )

            @staticmethod
            def parse_json_object(raw_text: str) -> dict[str, object]:
                import json
                return json.loads(raw_text)

        analyzer = SemanticAnalysisOrchestrator(FakeHFClient())  # type: ignore[arg-type]
        turns = [
            ConversationTurn(
                turnId="turn_user",
                sessionId="sess_test",
                speaker="user",
                transcript="Based on comparable units, I want to propose $1900.",
                startedAt="2025-01-01T00:00:00+00:00",
                endedAt="2025-01-01T00:00:01+00:00",
            ),
            ConversationTurn(
                turnId="turn_agent",
                sessionId="sess_test",
                speaker="agent",
                transcript="You made a concrete ask, but I still need a stronger justification.",
                startedAt="2025-01-01T00:00:02+00:00",
                endedAt="2025-01-01T00:00:03+00:00",
            ),
        ]
        analysis = await analyzer.analyze(
            session_id="sess_test",
            scenario="Negotiate rent",
            partner_tone="landlord",
            routing={"mode": "balanced", "chat_model": "fake", "context_window": 4},
            turns=turns,
            fallback_key_moments=[],
            heuristic_features={},
        )
        kinds = [moment.kind for moment in analysis["key_moments"]]
        self.assertEqual(analysis["source"], "llm_multi_pass")
        self.assertIn("first_anchor", kinds)
        self.assertIn("strong_pushback", kinds)


if __name__ == "__main__":
    unittest.main()
