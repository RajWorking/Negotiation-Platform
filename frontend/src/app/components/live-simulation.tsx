import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  Mic,
  Pause,
  PhoneOff,
  History,
  Play,
  RotateCcw,
  Send,
} from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { motion, AnimatePresence } from "motion/react";
import { clearActiveSession, loadActiveSession } from "../lib/storage";
import { createSpeechRecognition, speakWithBrowserVoice, stopSpeaking, createServerAudioPlayer, createPcmMicCapture } from "../lib/speech";
import type { ServerAudioPlayer, PcmMicCapture } from "../lib/speech";
import { endSession, getSessionState, pauseSession, requestCoaching, resumeSession, rewindSession, websocketUrl } from "../lib/api";
import type { CheckpointSummary, CoachingReportResponse, KeyMoment, ResponseSource, SessionStateResponse, TranscriptTurn } from "../lib/types";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------
interface TranscriptMessage {
  id: string;
  speaker: "user" | "ai";
  text: string;
  timestamp: number;
  source?: ResponseSource;
}

type SessionUiStatus = "connecting" | "listening" | "thinking" | "speaking" | "paused" | "ended" | "error";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toTranscriptMessage(turn: TranscriptTurn): TranscriptMessage {
  return {
    id: turn.turnId,
    speaker: turn.speaker === "user" ? "user" : "ai",
    text: turn.transcript,
    timestamp: Math.floor((new Date(turn.startedAt).getTime() || Date.now()) / 1000),
    source: turn.source,
  };
}

function toneToDisplayName(tone: string): string {
  const special: Record<string, string> = { landlord: "Landlord", partner: "Partner", interviewer: "Interviewer" };
  return special[tone] ?? tone.charAt(0).toUpperCase() + tone.slice(1);
}

const STATUS_LABELS: Record<SessionUiStatus, string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  paused: "Paused",
  ended: "Ended",
  error: "Error",
};

const THINKING_PHASE_LABELS: Record<string, string> = {
  "": "Thinking",
  generating_response: "Generating response\u2026",
  synthesizing_speech: "Converting to speech\u2026",
};

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function LiveSimulation() {
  const location = useLocation();
  const navigate = useNavigate();

  // Session metadata (from navigation state or sessionStorage)
  const activeSession = location.state ?? loadActiveSession();
  const sessionId: string | undefined = activeSession?.sessionId;
  const situation: string = activeSession?.situation ?? "Practice conversation";
  const tone: string = activeSession?.tone ?? "neutral";
  const mode: string = activeSession?.mode ?? "balanced";
  const voiceProfile = activeSession?.voiceProfile ?? {};
  const partnerLabel = toneToDisplayName(tone);

  // UI state
  const [elapsedTime, setElapsedTime] = useState(0);
  const [showCoaching, setShowCoaching] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [keyMoments, setKeyMoments] = useState<KeyMoment[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [currentSpeaker, setCurrentSpeaker] = useState<"user" | "ai" | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionUiStatus>("connecting");
  const [thinkingPhase, setThinkingPhase] = useState<string>("");
  const [coachingReport, setCoachingReport] = useState<CoachingReportResponse | null>(null);
  const [coachingLoading, setCoachingLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [lastAgentSource, setLastAgentSource] = useState<ResponseSource>("unknown");
  const [serverSTTAvailable, setServerSTTAvailable] = useState(false);
  const [serverTTSAvailable, setServerTTSAvailable] = useState(false);

  // Refs for values needed inside callbacks without re-renders
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const recognitionShouldRestartRef = useRef(false);
  const restartRecognitionTimeoutRef = useRef<number | null>(null);
  const showCoachingRef = useRef(false);
  const sessionStatusRef = useRef<SessionUiStatus>("connecting");
  const lastAgentUtteranceRef = useRef("");
  const ignoreRecognitionUntilRef = useRef(0);
  const serverAudioPlayerRef = useRef<ServerAudioPlayer | null>(null);
  const pcmCaptureRef = useRef<PcmMicCapture | null>(null);
  const serverSTTAvailableRef = useRef(false);
  const serverTTSAvailableRef = useRef(false);
  const finalizedBufferRef = useRef<string[]>([]);
  const turnFinalizeTimerRef = useRef<number | null>(null);

  // Keep refs in sync
  useEffect(() => { showCoachingRef.current = showCoaching; }, [showCoaching]);
  useEffect(() => { sessionStatusRef.current = sessionStatus; }, [sessionStatus]);
  useEffect(() => { serverSTTAvailableRef.current = serverSTTAvailable; }, [serverSTTAvailable]);
  useEffect(() => { serverTTSAvailableRef.current = serverTTSAvailable; }, [serverTTSAvailable]);

  // ---------------------------------------------------------------------------
  // Timer
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (sessionStatus === "paused" || sessionStatus === "ended") return;
    const interval = setInterval(() => setElapsedTime((prev) => prev + 1), 1000);
    return () => clearInterval(interval);
  }, [sessionStatus]);

  // Auto-scroll
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript, partialTranscript, showCoaching]);

  // ---------------------------------------------------------------------------
  // Apply full session state (used on initial load + rewind)
  // ---------------------------------------------------------------------------
  const applySessionState = useCallback((state: SessionStateResponse) => {
    setTranscript(state.turns.map(toTranscriptMessage));
    setKeyMoments(state.keyMoments);
    setCheckpoints(state.checkpoints);
    setPartialTranscript(state.liveState.partialTranscript ?? "");
    const mappedSpeaker = state.liveState.currentSpeaker === "agent" ? "ai" : state.liveState.currentSpeaker;
    setCurrentSpeaker(mappedSpeaker);
    if (state.status === "paused") {
      setSessionStatus("paused");
    } else if (state.status === "ended") {
      setSessionStatus("ended");
    } else {
      setSessionStatus(mappedSpeaker === "ai" ? "speaking" : "listening");
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Echo detection — prevent TTS playback from being recognized as user speech
  // ---------------------------------------------------------------------------
  const isLikelyEcho = useCallback((recognizedText: string): boolean => {
    const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    const recognized = norm(recognizedText);
    const agent = norm(lastAgentUtteranceRef.current);
    if (!recognized || !agent || recognized.length < 12) return false;
    if (agent.includes(recognized) || recognized.includes(agent.slice(0, 32))) return true;
    const recWords = new Set(recognized.split(" "));
    const agentWords = new Set(agent.split(" "));
    const overlap = [...recWords].filter((w) => agentWords.has(w)).length;
    return overlap / Math.max(recWords.size, 1) >= 0.7;
  }, []);

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------
  const sendRealtimeEvent = useCallback((payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const TURN_FINALIZE_DELAY_MS = 2000;

  const flushTurnBuffer = useCallback(() => {
    if (turnFinalizeTimerRef.current) {
      window.clearTimeout(turnFinalizeTimerRef.current);
      turnFinalizeTimerRef.current = null;
    }
    const buffered = finalizedBufferRef.current;
    if (buffered.length === 0) return;
    const fullText = buffered.join(" ").trim();
    finalizedBufferRef.current = [];
    if (fullText) {
      sendRealtimeEvent({ type: "user.transcript.final", text: fullText });
    }
  }, [sendRealtimeEvent]);

  // Forward declarations for mutual references between startInputLoop / speakAgentTurn
  const startInputLoopRef = useRef<() => Promise<void>>();
  const stopInputLoopRef = useRef<() => void>();

  // ---------------------------------------------------------------------------
  // Audio / speech recognition lifecycle
  // ---------------------------------------------------------------------------
  const stopInputLoop = useCallback(() => {
    // Flush any buffered transcript before tearing down
    flushTurnBuffer();

    recognitionShouldRestartRef.current = false;
    if (restartRecognitionTimeoutRef.current) {
      window.clearTimeout(restartRecognitionTimeoutRef.current);
      restartRecognitionTimeoutRef.current = null;
    }
    recognitionRef.current?.stop();
    if (pcmCaptureRef.current) {
      pcmCaptureRef.current.stop();
      pcmCaptureRef.current = null;
    }
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    if (serverAudioPlayerRef.current) {
      serverAudioPlayerRef.current.stop();
      serverAudioPlayerRef.current = null;
    }
  }, [flushTurnBuffer]);
  stopInputLoopRef.current = stopInputLoop;

  const startInputLoop = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage("Microphone access is not available in this browser");
      return;
    }

    if (!mediaStreamRef.current) {
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }

    // Server-side STT — send raw PCM, skip MediaRecorder and browser SpeechRecognition
    if (serverSTTAvailableRef.current) {
      if (!pcmCaptureRef.current) {
        pcmCaptureRef.current = createPcmMicCapture(
          mediaStreamRef.current,
          (base64) => sendRealtimeEvent({ type: "user.audio.chunk", base64, format: "pcm_s16le", sample_rate: 16000 }),
          500,
        );
      }
      pcmCaptureRef.current.start();
      setSessionStatus("listening");
      setCurrentSpeaker("user");
      return;
    }

    // Browser STT fallback — use MediaRecorder + SpeechRecognition
    if (!mediaRecorderRef.current) {
      const recorder = new MediaRecorder(mediaStreamRef.current, { mimeType: "audio/webm" });
      recorder.ondataavailable = async (chunkEvent) => {
        if (!chunkEvent.data.size) return;
        const base64 = await blobToBase64(chunkEvent.data);
        sendRealtimeEvent({ type: "user.audio.chunk", base64 });
      };
      mediaRecorderRef.current = recorder;
    }

    if (mediaRecorderRef.current.state === "inactive") {
      mediaRecorderRef.current.start(500);
    }

    if (!recognitionRef.current) {
      recognitionRef.current = createSpeechRecognition();
      if (!recognitionRef.current) {
        setErrorMessage("Live transcription requires a browser with SpeechRecognition support");
        return;
      }

      recognitionRef.current.onresult = (event) => {
        if (Date.now() < ignoreRecognitionUntilRef.current) return;

        let interim = "";
        const finalized: string[] = [];
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript?.trim();
          if (!text) continue;
          if (result.isFinal) {
            finalized.push(text);
          } else {
            interim += `${text} `;
          }
        }

        if (finalized.length > 0) {
          const finalText = finalized.join(" ").trim();
          if (finalText && !isLikelyEcho(finalText)) {
            finalizedBufferRef.current.push(finalText);
          }
          // Reset the debounce timer — user may still be speaking
          if (turnFinalizeTimerRef.current) {
            window.clearTimeout(turnFinalizeTimerRef.current);
          }
          turnFinalizeTimerRef.current = window.setTimeout(() => {
            flushTurnBuffer();
          }, TURN_FINALIZE_DELAY_MS);
        }

        // Show accumulated + interim text as live partial
        const displayText = [...finalizedBufferRef.current, interim].join(" ").trim();
        if (displayText && !isLikelyEcho(displayText)) {
          sendRealtimeEvent({ type: "user.transcript.partial", text: displayText });
        }
      };

      recognitionRef.current.onerror = () => {
        setErrorMessage("Speech recognition stopped unexpectedly");
      };

      recognitionRef.current.onend = () => {
        if (
          recognitionShouldRestartRef.current &&
          sessionStatusRef.current !== "paused" &&
          sessionStatusRef.current !== "ended"
        ) {
          recognitionRef.current?.start();
        }
      };
    }

    recognitionShouldRestartRef.current = true;
    recognitionRef.current.start();
    setSessionStatus("listening");
    setCurrentSpeaker("user");
  }, [sendRealtimeEvent, isLikelyEcho, flushTurnBuffer, TURN_FINALIZE_DELAY_MS]);
  startInputLoopRef.current = startInputLoop;

  const speakAgentTurn = useCallback((text: string) => {
    stopInputLoopRef.current?.();
    lastAgentUtteranceRef.current = text;
    setCurrentSpeaker("ai");
    setSessionStatus("speaking");

    if (serverTTSAvailableRef.current) {
      // Server TTS — audio arrives via WebSocket agent.response.audio.chunk events
      const player = createServerAudioPlayer();
      serverAudioPlayerRef.current = player;
      player.onPlaybackEnd(() => {
        ignoreRecognitionUntilRef.current = Date.now() + 1200;
        if (!showCoachingRef.current) {
          restartRecognitionTimeoutRef.current = window.setTimeout(() => {
            void startInputLoopRef.current?.();
          }, 1200);
        }
      });
    } else {
      // Browser TTS fallback
      speakWithBrowserVoice({
        text,
        voiceProfile,
        onStart: () => {
          setCurrentSpeaker("ai");
          setSessionStatus("speaking");
        },
        onEnd: () => {
          ignoreRecognitionUntilRef.current = Date.now() + 1200;
          if (!showCoachingRef.current) {
            restartRecognitionTimeoutRef.current = window.setTimeout(() => {
              void startInputLoopRef.current?.();
            }, 1200);
          }
        },
      });
    }
  }, [voiceProfile]);

  // ---------------------------------------------------------------------------
  // WebSocket message handler
  // ---------------------------------------------------------------------------
  const connectWebSocket = useCallback((activeSessionId: string) => {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(websocketUrl(activeSessionId));
      wsRef.current = socket;

      socket.onopen = () => resolve();

      socket.onmessage = (event) => {
        const data = JSON.parse(String(event.data));

        switch (data.type) {
          case "session.ready":
            if (data.state) applySessionState(data.state);
            if (data.capabilities) {
              const stt = !!data.capabilities.stt;
              const tts = !!data.capabilities.tts;
              setServerSTTAvailable(stt);
              setServerTTSAvailable(tts);
              // Sync refs immediately so startInputLoop sees them
              serverSTTAvailableRef.current = stt;
              serverTTSAvailableRef.current = tts;
            }
            // Start mic/STT now that capabilities are known
            if (data.state) {
              const st = data.state as SessionStateResponse;
              if (st.status !== "paused" && st.status !== "ended" && st.liveState.currentSpeaker !== "agent") {
                void startInputLoopRef.current?.();
              }
            }
            break;

          case "user.transcript.partial":
            setPartialTranscript(String(data.text ?? ""));
            setCurrentSpeaker("user");
            setSessionStatus("listening");
            break;

          case "user.transcript.final":
            if (data.turn) {
              setPartialTranscript("");
              setTranscript((prev) => [...prev, toTranscriptMessage(data.turn as TranscriptTurn)]);
              setCurrentSpeaker("user");
            }
            break;

          case "stt.transcript.partial":
            setPartialTranscript(String(data.text ?? ""));
            setCurrentSpeaker("user");
            setSessionStatus("listening");
            break;

          case "stt.transcript.final":
            // Keep showing the text as partial until user.transcript.final replaces it
            if (data.text) setPartialTranscript(String(data.text));
            setCurrentSpeaker("user");
            break;

          case "agent.thinking":
            stopInputLoopRef.current?.();
            setCurrentSpeaker(null);
            setSessionStatus("thinking");
            setThinkingPhase("");
            break;

          case "agent.status":
            setThinkingPhase(String(data.phase ?? ""));
            break;

          case "agent.response.text":
            setThinkingPhase("");
            if (data.turn) {
              const turn = data.turn as TranscriptTurn & { source?: ResponseSource };
              const source = turn.source ?? (data.turn as Record<string, unknown>).source as ResponseSource | undefined ?? "unknown";
              setLastAgentSource(source);
              setTranscript((prev) => [...prev, { ...toTranscriptMessage(turn), source }]);
              speakAgentTurn(turn.transcript);
            }
            break;

          case "agent.response.audio.chunk":
            if (serverAudioPlayerRef.current && data.base64) {
              serverAudioPlayerRef.current.feedChunk(String(data.base64), Number(data.sample_rate ?? 24000));
            }
            break;

          case "agent.response.audio.end":
            if (serverAudioPlayerRef.current) {
              serverAudioPlayerRef.current.markEnd();
            }
            break;

          case "session.checkpoint.created":
            if (data.checkpoint) {
              setCheckpoints((prev) => [...prev, data.checkpoint as CheckpointSummary]);
            }
            break;

          case "session.key_moment.created":
            if (data.key_moment) {
              setKeyMoments((prev) => {
                const km = data.key_moment as KeyMoment;
                const next = [...prev.filter((m) => m.keyMomentId !== km.keyMomentId && m.kind !== km.kind), km];
                return next.sort((a, b) => a.turnIndex - b.turnIndex);
              });
            }
            break;

          case "session.paused":
            setSessionStatus("paused");
            setCurrentSpeaker(null);
            break;

          case "session.resumed":
            setSessionStatus("listening");
            break;

          case "session.rewound":
            if (data.state) applySessionState(data.state as SessionStateResponse);
            break;

          case "error":
            setSessionStatus("error");
            setErrorMessage(String(data.message ?? "Unexpected realtime error"));
            break;

          default:
            break;
        }
      };

      socket.onerror = () => {
        setSessionStatus("error");
        setErrorMessage("Realtime connection failed");
        reject(new Error("Realtime connection failed"));
      };
    });
  }, [applySessionState, speakAgentTurn]);

  // ---------------------------------------------------------------------------
  // Session initialization
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!sessionId) {
      navigate("/");
      return;
    }

    let cancelled = false;
    const connectSession = async () => {
      try {
        const state = await getSessionState(sessionId);
        if (cancelled) return;
        applySessionState(state);
        await connectWebSocket(sessionId);
        // startInputLoop is now triggered by the session.ready WebSocket event
        // so that server capabilities (STT/TTS) are known before deciding the input path
      } catch (error) {
        if (!cancelled) {
          setSessionStatus("error");
          setErrorMessage(error instanceof Error ? error.message : "Unable to load session");
        }
      }
    };
    void connectSession();

    return () => {
      cancelled = true;
      stopInputLoop();
      stopSpeaking();
      if (serverAudioPlayerRef.current) {
        serverAudioPlayerRef.current.stop();
        serverAudioPlayerRef.current = null;
      }
      wsRef.current?.close();
    };
  }, [navigate, sessionId, applySessionState, connectWebSocket, stopInputLoop]);

  // ---------------------------------------------------------------------------
  // Key moments + checkpoints for sidebar
  // ---------------------------------------------------------------------------
  const keyMomentEntries = keyMoments
    .map((moment) => {
      const targetMessage = transcript.find((m) => m.id === moment.turnId);
      if (!targetMessage) return null;
      return { moment, messageId: targetMessage.id };
    })
    .filter((e): e is { moment: KeyMoment; messageId: string } => Boolean(e));

  const scrollToMessage = (messageId: string) => {
    const element = document.getElementById(messageId);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    const bubble = element.querySelector(".message-bubble");
    if (bubble) {
      bubble.classList.add("ring-2", "ring-teal-500", "ring-offset-2");
      window.setTimeout(() => bubble.classList.remove("ring-2", "ring-teal-500", "ring-offset-2"), 1600);
    }
  };

  const getKeyMomentNumber = (messageId: string) => {
    const idx = keyMomentEntries.findIndex((e) => e.messageId === messageId);
    return idx >= 0 ? idx + 1 : null;
  };

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const handleSubmitTurn = useCallback(() => {
    flushTurnBuffer();
    if (serverSTTAvailableRef.current) {
      sendRealtimeEvent({ type: "user.audio.finalize" });
    }
  }, [flushTurnBuffer, sendRealtimeEvent]);

  const handlePauseForCoaching = async () => {
    if (!sessionId) return;
    setShowCoaching(true);
    setCoachingLoading(true);
    setCoachingReport(null);
    stopInputLoop();
    stopSpeaking();

    try {
      await pauseSession(sessionId);
      const report = await requestCoaching(sessionId, 6);
      setCoachingReport(report);
      setSessionStatus("paused");
      setCurrentSpeaker(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to load coaching");
    } finally {
      setCoachingLoading(false);
    }
  };

  const handleResumeSimulation = async () => {
    if (!sessionId) return;
    await resumeSession(sessionId);
    setShowCoaching(false);
    setCoachingReport(null);
    await startInputLoop();
  };

  const handleRewind = async (checkpointId: string) => {
    if (!sessionId) return;
    stopInputLoop();
    stopSpeaking();
    try {
      await rewindSession(sessionId, checkpointId);
      // The WebSocket broadcast will trigger applySessionState via "session.rewound"
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Rewind failed");
    }
  };

  const handleEndConversation = async () => {
    if (!confirm("Are you sure you want to end this simulation?")) return;
    if (sessionId) await endSession(sessionId);
    stopInputLoop();
    stopSpeaking();
    clearActiveSession();
    navigate("/");
  };

  const getCheckpointTimestamp = (createdAt: string) =>
    new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-slate-100 text-slate-800 flex flex-col">
      {/* Top Bar */}
      <div className="border-b border-slate-200 bg-white/80 backdrop-blur-sm px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-medium truncate max-w-md text-slate-800">{situation}</h1>
          <Badge variant="outline" className="bg-slate-100 text-slate-600 border-slate-300">
            {partnerLabel}
          </Badge>
          <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200 capitalize">
            {mode}
          </Badge>
          <Badge variant="outline" className="bg-teal-50 text-teal-700 border-teal-200">
            {sessionStatus === "thinking"
              ? (THINKING_PHASE_LABELS[thinkingPhase] ?? "Thinking")
              : STATUS_LABELS[sessionStatus]}
          </Badge>
          {lastAgentSource === "heuristic" && (
            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs">
              Heuristic mode
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-4">
          <div className="text-lg font-mono text-slate-500">{formatTime(elapsedTime)}</div>
        </div>
      </div>

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar — Key Moments & Checkpoints */}
        <div className="w-80 bg-white/80 backdrop-blur-sm border-r border-slate-200 shadow-sm flex flex-col">
          <div className="p-4 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <History className="w-4 h-4" />
              Key Moments
            </h2>
          </div>
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-2">
              {keyMomentEntries.map(({ moment, messageId }, idx) => (
                <button
                  key={moment.keyMomentId}
                  onClick={() => scrollToMessage(messageId)}
                  className="w-full text-left px-4 py-3 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 hover:border-slate-300 transition-all"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-teal-100 text-teal-600 flex items-center justify-center text-xs font-semibold flex-shrink-0">
                      {idx + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 mb-1">{moment.label}</div>
                      <div className="text-xs text-slate-500 mb-1">{moment.summary}</div>
                      <div className="text-xs text-slate-500 font-mono">{getCheckpointTimestamp(moment.createdAt)}</div>
                    </div>
                  </div>
                </button>
              ))}
              {keyMomentEntries.length === 0 && (
                <div className="text-sm text-slate-500">Key moments appear after completed turns.</div>
              )}
            </div>

            {/* Checkpoints / Rewind */}
            {checkpoints.length > 0 && (
              <div className="mt-6">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1">
                  <RotateCcw className="w-3 h-3" />
                  Checkpoints
                </h3>
                <div className="space-y-1">
                  {checkpoints.map((cp) => (
                    <div
                      key={cp.checkpointId}
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-slate-50 border border-slate-200 text-xs"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-slate-700 line-clamp-2">{cp.summary}</div>
                        <div className="text-slate-400 font-mono">{getCheckpointTimestamp(cp.createdAt)}</div>
                      </div>
                      <button
                        onClick={() => handleRewind(cp.checkpointId)}
                        className="flex-shrink-0 text-indigo-600 hover:text-indigo-800 transition-colors"
                        title="Rewind to this point"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col items-center justify-center p-8 relative overflow-auto">
          <div className="w-full max-w-7xl flex items-center gap-6 h-full">
            {/* User Mic — Left */}
            <div className="flex flex-col items-center gap-4 flex-shrink-0">
              <div className="relative w-32 h-32">
                <motion.div
                  className="absolute inset-0 rounded-full"
                  animate={{
                    boxShadow: currentSpeaker === "user"
                      ? ["0 0 0 0px rgba(20,184,166,0.4)", "0 0 0 20px rgba(20,184,166,0)", "0 0 0 0px rgba(20,184,166,0)"]
                      : "0 0 0 0px rgba(20,184,166,0)",
                  }}
                  transition={{ duration: 1.5, repeat: currentSpeaker === "user" ? Infinity : 0, ease: "easeOut" }}
                >
                  <div className="absolute inset-4 rounded-full bg-teal-500/20 border-2 border-teal-500/40" />
                </motion.div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full bg-white shadow-lg flex items-center justify-center border-2 border-teal-400/60">
                    <motion.div animate={{ scale: currentSpeaker === "user" ? [1, 1.1, 1] : 1 }} transition={{ duration: 1, repeat: currentSpeaker === "user" ? Infinity : 0 }}>
                      <Mic className={`w-6 h-6 ${currentSpeaker === "user" ? "text-teal-500" : "text-slate-400"}`} />
                    </motion.div>
                  </div>
                </div>
              </div>
              <span className="text-sm font-medium text-teal-600">You</span>
            </div>

            {/* Transcript Panel */}
            <div className="flex-1 bg-white/80 backdrop-blur-sm rounded-xl p-6 shadow-lg border border-slate-200 h-[calc(100vh-16rem)]">
              <ScrollArea className="h-full">
                <div className="space-y-4 pr-4 pt-4">
                  {transcript.map((message) => (
                    <div key={message.id} id={message.id} className={`flex ${message.speaker === "user" ? "justify-start" : "justify-end"} transition-all duration-300`}>
                      <div className={`relative max-w-[70%] px-4 py-3 rounded-lg shadow-sm ${
                        message.speaker === "user"
                          ? "bg-teal-50 border border-teal-200 text-teal-900"
                          : "bg-orange-50 border border-orange-200 text-orange-900"
                      } message-bubble`}>
                        {getKeyMomentNumber(message.id) && (
                          <div className="absolute -top-2 -right-2 w-6 h-6 bg-teal-500 rounded-full flex items-center justify-center shadow-md">
                            <span className="text-white text-xs font-bold">{getKeyMomentNumber(message.id)}</span>
                          </div>
                        )}
                        <div className="text-xs opacity-70 mb-1 font-medium">
                          {message.speaker === "user" ? "You" : partnerLabel}
                        </div>
                        <div className="text-sm">{message.text}</div>
                      </div>
                    </div>
                  ))}
                  {partialTranscript && (
                    <div className="flex justify-start transition-all duration-300">
                      <div className="relative max-w-[70%] px-4 py-3 rounded-lg border border-dashed border-teal-200 bg-teal-50/70 text-teal-900">
                        <div className="text-xs opacity-70 mb-1 font-medium">You</div>
                        <div className="text-sm italic">{partialTranscript}</div>
                      </div>
                    </div>
                  )}
                  <div ref={scrollAnchorRef} />
                </div>
              </ScrollArea>
            </div>

            {/* AI Mic — Right */}
            <div className="flex flex-col items-center gap-4 flex-shrink-0">
              <div className="relative w-32 h-32">
                <motion.div
                  className="absolute inset-0 rounded-full"
                  animate={{
                    boxShadow: currentSpeaker === "ai"
                      ? ["0 0 0 0px rgba(251,146,60,0.4)", "0 0 0 20px rgba(251,146,60,0)", "0 0 0 0px rgba(251,146,60,0)"]
                      : "0 0 0 0px rgba(251,146,60,0)",
                  }}
                  transition={{ duration: 1.5, repeat: currentSpeaker === "ai" ? Infinity : 0, ease: "easeOut" }}
                >
                  <div className="absolute inset-4 rounded-full bg-orange-400/20 border-2 border-orange-400/40" />
                </motion.div>
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full bg-white shadow-lg flex items-center justify-center border-2 border-orange-400/60">
                    <motion.div animate={{ scale: currentSpeaker === "ai" ? [1, 1.1, 1] : 1 }} transition={{ duration: 1, repeat: currentSpeaker === "ai" ? Infinity : 0 }}>
                      <Mic className={`w-6 h-6 ${currentSpeaker === "ai" ? "text-orange-400" : "text-slate-400"}`} />
                    </motion.div>
                  </div>
                </div>
              </div>
              <span className="text-sm font-medium text-orange-500">{partnerLabel}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Control Bar */}
      <div className="border-t border-slate-200 px-6 py-6 bg-white/90 backdrop-blur-sm shadow-lg">
        <div className="max-w-4xl mx-auto flex items-center justify-center gap-4">
          <Button
            onClick={handleSubmitTurn}
            disabled={sessionStatus !== "listening"}
            size="lg"
            className="bg-teal-500 hover:bg-teal-600 text-white px-8 py-6 rounded-xl shadow-lg hover:shadow-xl transition-all disabled:opacity-50"
          >
            <Send className="w-5 h-5 mr-2" />
            Done Speaking
          </Button>
          <Button
            onClick={handlePauseForCoaching}
            size="lg"
            className="bg-yellow-500 hover:bg-yellow-600 text-white px-8 py-6 rounded-xl shadow-lg hover:shadow-xl transition-all"
          >
            <Pause className="w-5 h-5 mr-2" />
            Pause & Get Coaching
          </Button>
          <Button
            onClick={handleEndConversation}
            size="lg"
            className="bg-red-500 hover:bg-red-600 text-white px-8 py-6 rounded-xl shadow-lg hover:shadow-xl transition-all"
          >
            <PhoneOff className="w-5 h-5 mr-2" />
            End Call
          </Button>
        </div>
      </div>

      {/* Coaching Overlay */}
      <AnimatePresence>
        {showCoaching && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40"
              onClick={handleResumeSimulation}
            />
            <motion.div
              initial={{ x: 400, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 400, opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-[450px] bg-gradient-to-br from-teal-900 to-teal-950 border-l border-teal-700 shadow-2xl z-50 flex flex-col"
            >
              <div className="p-6 border-b border-teal-700">
                <h2 className="text-2xl font-semibold text-teal-100">Strategic Feedback</h2>
                <p className="text-sm text-teal-300 mt-1">Review your approach and adjust</p>
                {coachingReport?.source === "heuristic" && (
                  <p className="text-xs text-amber-300 mt-2">Based on behavioral patterns (LLM unavailable)</p>
                )}
              </div>

              <ScrollArea className="flex-1 min-h-0 p-6">
                {coachingLoading ? (
                  <div className="text-sm text-teal-200">Analyzing recent turns and guidance materials...</div>
                ) : coachingReport ? (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-lg font-medium text-teal-100 mb-3 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-green-400" />
                        What You're Doing Well
                      </h3>
                      <ul className="space-y-2 text-teal-200 text-sm">
                        {coachingReport.strengths.map((item) => (
                          <li key={item} className="flex gap-2">
                            <span className="text-green-400">•</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <h3 className="text-lg font-medium text-teal-100 mb-3 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-amber-400" />
                        Weak Signals
                      </h3>
                      <ul className="space-y-2 text-teal-200 text-sm">
                        {coachingReport.weak_signals.map((item) => (
                          <li key={item} className="flex gap-2">
                            <span className="text-amber-400">•</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <h3 className="text-lg font-medium text-teal-100 mb-3 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-blue-400" />
                        Suggested Next Move
                      </h3>
                      <div className="bg-teal-950/50 border border-teal-700 rounded-lg p-4">
                        <p className="text-teal-100 text-sm leading-relaxed">{coachingReport.suggested_next_move}</p>
                      </div>
                    </div>

                    {coachingReport.retrieved_evidence.length > 0 && (
                      <div>
                        <h3 className="text-lg font-medium text-teal-100 mb-3 flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-cyan-400" />
                          Retrieved Evidence
                        </h3>
                        <div className="space-y-3">
                          {coachingReport.retrieved_evidence.map((item) => (
                            <div key={`${item.source}-${item.snippet}`} className="rounded-lg border border-teal-700 bg-teal-950/40 p-4">
                              <div className="text-xs uppercase tracking-wide text-teal-300 mb-2">{item.source}</div>
                              <div className="text-sm text-teal-100">{item.snippet}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-teal-200">No coaching report is available yet.</div>
                )}
              </ScrollArea>

              <div className="p-6 border-t border-teal-700">
                <Button onClick={handleResumeSimulation} className="w-full bg-teal-600 hover:bg-teal-700 text-white h-12">
                  <Play className="w-5 h-5 mr-2" />
                  Resume Simulation
                </Button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Error Toast */}
      {errorMessage && (
        <div className="fixed bottom-6 right-6 max-w-sm rounded-lg border border-red-200 bg-white px-4 py-3 text-sm text-red-700 shadow-lg">
          {errorMessage}
          <button onClick={() => setErrorMessage("")} className="ml-3 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}
    </div>
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
