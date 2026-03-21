import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  Mic,
  Pause,
  PhoneOff,
  Settings,
  StickyNote,
  Download,
  History,
  Play,
  Flag,
} from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { motion, AnimatePresence } from "motion/react";
import { clearActiveSession, loadActiveSession } from "../lib/storage";
import { createSpeechRecognition, speakWithBrowserVoice, stopSpeaking } from "../lib/speech";
import { endSession, getCheckpoints, getSessionState, pauseSession, requestCoaching, resumeSession, websocketUrl } from "../lib/api";
import type { CheckpointSummary, CoachingReportResponse, SessionStateResponse, TranscriptTurn } from "../lib/types";

interface TranscriptMessage {
  id: string;
  speaker: "user" | "ai";
  text: string;
  timestamp: number;
}

type SessionUiStatus = "connecting" | "listening" | "thinking" | "speaking" | "paused" | "ended" | "error";

function toTranscriptMessage(turn: TranscriptTurn): TranscriptMessage {
  return {
    id: turn.turnId,
    speaker: turn.speaker === "user" ? "user" : "ai",
    text: turn.transcript,
    timestamp: Math.floor((new Date(turn.startedAt).getTime() || Date.now()) / 1000),
  };
}

function toneToDisplayName(tone: string) {
  if (tone === "landlord") {
    return "Landlord";
  }
  if (tone === "partner") {
    return "Partner";
  }
  if (tone === "interviewer") {
    return "Interviewer";
  }
  return tone.charAt(0).toUpperCase() + tone.slice(1);
}

export function LiveSimulation() {
  const location = useLocation();
  const navigate = useNavigate();
  const [elapsedTime, setElapsedTime] = useState(0);
  const [showCoaching, setShowCoaching] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [currentSpeaker, setCurrentSpeaker] = useState<"user" | "ai" | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionUiStatus>("connecting");
  const [coachingReport, setCoachingReport] = useState<CoachingReportResponse | null>(null);
  const [coachingLoading, setCoachingLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
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

  const activeSession = location.state ?? loadActiveSession();
  const sessionId = activeSession?.sessionId;
  const situation = activeSession?.situation ?? "Practice conversation";
  const tone = activeSession?.tone ?? "neutral";
  const voiceProfile = activeSession?.voiceProfile ?? {};
  const partnerLabel = toneToDisplayName(tone);

  // Timer
  useEffect(() => {
    if (sessionStatus === "paused" || sessionStatus === "ended") {
      return;
    }
    const interval = setInterval(() => {
      setElapsedTime((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [sessionStatus]);

  // Auto-scroll transcript
  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript, partialTranscript, showCoaching]);

  useEffect(() => {
    showCoachingRef.current = showCoaching;
  }, [showCoaching]);

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    if (!sessionId) {
      navigate("/");
      return;
    }

    let cancelled = false;

    const connectSession = async () => {
      try {
        const [state, checkpointList] = await Promise.all([
          getSessionState(sessionId),
          getCheckpoints(sessionId),
        ]);
        if (cancelled) {
          return;
        }
        applySessionState(state);
        setCheckpoints(checkpointList);
        await connectWebSocket(sessionId);
        if (state.status !== "paused" && state.status !== "ended" && state.liveState.currentSpeaker !== "agent") {
          await startInputLoop();
        }
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
      wsRef.current?.close();
    };
  }, [navigate, sessionId]);

  const applySessionState = (state: SessionStateResponse) => {
    setTranscript(state.turns.map(toTranscriptMessage));
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
  };

  const keyMomentEntries = checkpoints
    .map((checkpoint, index) => {
      const targetMessage = transcript[checkpoint.turnIndex - 1];
      if (!targetMessage) {
        return null;
      }
      return {
        checkpoint,
        index,
        messageId: targetMessage.id,
      };
    })
    .filter((entry): entry is { checkpoint: CheckpointSummary; index: number; messageId: string } => Boolean(entry));

  const scrollToMessage = (messageId: string) => {
    const element = document.getElementById(messageId);
    if (!element) {
      return;
    }
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    const bubble = element.querySelector(".message-bubble");
    if (bubble) {
      bubble.classList.add("ring-2", "ring-teal-500", "ring-offset-2");
      window.setTimeout(() => {
        bubble.classList.remove("ring-2", "ring-teal-500", "ring-offset-2");
      }, 1600);
    }
  };

  const getKeyMomentNumber = (messageId: string) => {
    const index = keyMomentEntries.findIndex((entry) => entry.messageId === messageId);
    return index >= 0 ? index + 1 : null;
  };

  const isLikelyEcho = (recognizedText: string) => {
    const normalizedRecognized = recognizedText.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    const normalizedAgent = lastAgentUtteranceRef.current.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    if (!normalizedRecognized || !normalizedAgent || normalizedRecognized.length < 12) {
      return false;
    }
    if (normalizedAgent.includes(normalizedRecognized) || normalizedRecognized.includes(normalizedAgent.slice(0, 32))) {
      return true;
    }
    const recognizedWords = new Set(normalizedRecognized.split(" "));
    const agentWords = new Set(normalizedAgent.split(" "));
    const overlap = [...recognizedWords].filter((word) => agentWords.has(word)).length;
    return overlap / Math.max(recognizedWords.size, 1) >= 0.7;
  };

  const connectWebSocket = (activeSessionId: string) => {
    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(websocketUrl(activeSessionId));
      wsRef.current = socket;
      socket.onopen = () => resolve();
      socket.onmessage = (event) => {
        const data = JSON.parse(String(event.data));
        if (data.type === "session.ready" && data.state) {
          applySessionState(data.state);
          return;
        }
        if (data.type === "user.transcript.partial") {
          setPartialTranscript(String(data.text ?? ""));
          setCurrentSpeaker("user");
          setSessionStatus("listening");
          return;
        }
        if (data.type === "user.transcript.final" && data.turn) {
          setPartialTranscript("");
          setTranscript((prev) => [...prev, toTranscriptMessage(data.turn as TranscriptTurn)]);
          setCurrentSpeaker("user");
          return;
        }
        if (data.type === "agent.thinking") {
          setCurrentSpeaker(null);
          setSessionStatus("thinking");
          return;
        }
        if (data.type === "agent.response.text" && data.turn) {
          const turn = data.turn as TranscriptTurn;
          setTranscript((prev) => [...prev, toTranscriptMessage(turn)]);
          speakAgentTurn(turn.transcript);
          return;
        }
        if (data.type === "agent.response.audio.end") {
          return;
        }
        if (data.type === "session.checkpoint.created" && data.checkpoint) {
          setCheckpoints((prev) => {
            const next = [
              ...prev.filter((item) => item.checkpointId !== data.checkpoint.checkpointId),
              {
                checkpointId: data.checkpoint.checkpointId,
                turnIndex: data.checkpoint.turnIndex,
                summary: data.checkpoint.summary,
                createdAt: data.checkpoint.createdAt,
              },
            ];
            return next.sort((left, right) => left.turnIndex - right.turnIndex);
          });
          return;
        }
        if (data.type === "session.paused") {
          setSessionStatus("paused");
          setCurrentSpeaker(null);
          return;
        }
        if (data.type === "session.resumed") {
          setSessionStatus("listening");
          return;
        }
        if (data.type === "session.rewound" && data.state) {
          applySessionState(data.state as SessionStateResponse);
          return;
        }
        if (data.type === "error") {
          setSessionStatus("error");
          setErrorMessage(String(data.message ?? "Unexpected realtime error"));
        }
      };
      socket.onerror = () => {
        setSessionStatus("error");
        setErrorMessage("Realtime connection failed");
        reject(new Error("Realtime connection failed"));
      };
    });
  };

  const sendRealtimeEvent = (payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  };

  const startInputLoop = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setErrorMessage("Microphone access is not available in this browser");
      return;
    }

    if (!mediaStreamRef.current) {
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    }

    if (!mediaRecorderRef.current) {
      const recorder = new MediaRecorder(mediaStreamRef.current, { mimeType: "audio/webm" });
      recorder.ondataavailable = async (chunkEvent) => {
        if (!chunkEvent.data.size) {
          return;
        }
        const base64 = await blobToBase64(chunkEvent.data);
        sendRealtimeEvent({
          type: "user.audio.chunk",
          base64,
        });
      };
      mediaRecorderRef.current = recorder;
    }

    if (mediaRecorderRef.current.state === "inactive") {
      mediaRecorderRef.current.start(1000);
    }

    if (!recognitionRef.current) {
      recognitionRef.current = createSpeechRecognition();
      if (!recognitionRef.current) {
        setErrorMessage("Live transcription requires a browser with SpeechRecognition support");
        return;
      }
      if (recognitionRef.current) {
        recognitionRef.current.onresult = (event) => {
          if (Date.now() < ignoreRecognitionUntilRef.current) {
            return;
          }
          let interim = "";
          const finalized: string[] = [];
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            const text = result[0]?.transcript?.trim();
            if (!text) {
              continue;
            }
            if (result.isFinal) {
              finalized.push(text);
            } else {
              interim += `${text} `;
            }
          }
          if (interim.trim() && !isLikelyEcho(interim.trim())) {
            sendRealtimeEvent({
              type: "user.transcript.partial",
              text: interim.trim(),
            });
          }
          if (finalized.length > 0) {
            const finalText = finalized.join(" ").trim();
            if (isLikelyEcho(finalText)) {
              return;
            }
            sendRealtimeEvent({
              type: "user.transcript.final",
              text: finalText,
            });
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
    }

    if (recognitionRef.current) {
      recognitionShouldRestartRef.current = true;
      recognitionRef.current.start();
    }

    setSessionStatus("listening");
    setCurrentSpeaker("user");
  };

  const stopInputLoop = () => {
    recognitionShouldRestartRef.current = false;
    if (restartRecognitionTimeoutRef.current) {
      window.clearTimeout(restartRecognitionTimeoutRef.current);
      restartRecognitionTimeoutRef.current = null;
    }
    recognitionRef.current?.stop();
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
  };

  const speakAgentTurn = (text: string) => {
    stopInputLoop();
    lastAgentUtteranceRef.current = text;
    setCurrentSpeaker("ai");
    setSessionStatus("speaking");
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
            void startInputLoop();
          }, 1200);
        }
      },
    });
  };

  const handlePauseForCoaching = async () => {
    if (!sessionId) {
      return;
    }
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
    if (!sessionId) {
      return;
    }
    await resumeSession(sessionId);
    setShowCoaching(false);
    setCoachingReport(null);
    await startInputLoop();
  };

  const handleEndConversation = async () => {
    if (confirm("Are you sure you want to end this simulation?")) {
      if (sessionId) {
        await endSession(sessionId);
      }
      stopInputLoop();
      stopSpeaking();
      clearActiveSession();
      navigate("/");
    }
  };

  const getCheckpointTimestamp = (createdAt: string) => {
    return new Date(createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const statusLabel = sessionStatus === "connecting"
    ? "Connecting"
    : sessionStatus === "listening"
      ? "Listening"
      : sessionStatus === "thinking"
        ? "Thinking"
        : sessionStatus === "speaking"
          ? "Speaking"
          : sessionStatus === "paused"
            ? "Paused"
            : sessionStatus === "ended"
              ? "Ended"
              : "Error";

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-slate-100 text-slate-800 flex flex-col">
      {/* Top Bar */}
      <div className="border-b border-slate-200 bg-white/80 backdrop-blur-sm px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-medium truncate max-w-md text-slate-800">{situation}</h1>
          <Badge variant="outline" className="bg-slate-100 text-slate-600 border-slate-300">
            {tone}
          </Badge>
          <Badge variant="outline" className="bg-teal-50 text-teal-700 border-teal-200">
            {statusLabel}
          </Badge>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-lg font-mono text-slate-500">{formatTime(elapsedTime)}</div>
          <Button
            variant="ghost"
            size="icon"
            className="text-slate-500 hover:text-slate-800 hover:bg-slate-100"
          >
            <Settings className="w-5 h-5" />
          </Button>
        </div>
      </div>

      {/* Main Layout with Sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - Key Moments */}
        <div className="w-64 bg-white/80 backdrop-blur-sm border-r border-slate-200 shadow-sm flex flex-col">
          <div className="p-4 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <History className="w-4 h-4" />
              Key Moments
            </h2>
          </div>
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-2">
              {keyMomentEntries.map(({ checkpoint, index, messageId }) => (
                <button
                  key={checkpoint.checkpointId}
                  onClick={() => scrollToMessage(messageId)}
                  className="w-full text-left px-4 py-3 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 hover:border-slate-300 transition-all group"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-teal-100 text-teal-600 flex items-center justify-center text-xs font-semibold flex-shrink-0">
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 mb-1">
                        Turn {checkpoint.turnIndex}
                      </div>
                      <div className="text-xs text-slate-500 mb-1">
                        {checkpoint.summary}
                      </div>
                      <div className="text-xs text-slate-500 font-mono">
                        {getCheckpointTimestamp(checkpoint.createdAt)}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
              {keyMomentEntries.length === 0 && (
                <div className="text-sm text-slate-500">Key moments appear after completed turns.</div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col items-center justify-center p-8 relative overflow-auto">
          {/* Waveform Visualization and Transcript - Side by Side Layout */}
          <div className="w-full max-w-7xl flex items-center gap-6 h-full">
            {/* User Microphone - Left Side */}
            <div className="flex flex-col items-center gap-4 flex-shrink-0">
              <div className="relative w-32 h-32">
                {/* User Waveform (Teal) */}
                <motion.div
                  className="absolute inset-0 rounded-full"
                  animate={{
                    boxShadow: currentSpeaker === "user" 
                      ? [
                          "0 0 0 0px rgba(20, 184, 166, 0.4)",
                          "0 0 0 20px rgba(20, 184, 166, 0)",
                          "0 0 0 0px rgba(20, 184, 166, 0)",
                        ]
                      : "0 0 0 0px rgba(20, 184, 166, 0)",
                  }}
                  transition={{
                    duration: 1.5,
                    repeat: currentSpeaker === "user" ? Infinity : 0,
                    ease: "easeOut",
                  }}
                >
                  <div className="absolute inset-4 rounded-full bg-teal-500/20 border-2 border-teal-500/40" />
                </motion.div>

                {/* Center Icon */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full bg-white shadow-lg flex items-center justify-center border-2 border-teal-400/60">
                    <motion.div
                      animate={{ 
                        scale: currentSpeaker === "user" ? [1, 1.1, 1] : 1 
                      }}
                      transition={{ duration: 1, repeat: currentSpeaker === "user" ? Infinity : 0 }}
                    >
                      <Mic className={`w-6 h-6 ${currentSpeaker === "user" ? "text-teal-500" : "text-slate-400"}`} />
                    </motion.div>
                  </div>
                </div>
              </div>
              <span className="text-sm font-medium text-teal-600">You</span>
            </div>

            {/* Transcript Panel - Center */}
            <div className="flex-1 bg-white/80 backdrop-blur-sm rounded-xl p-6 shadow-lg border border-slate-200 h-[calc(100vh-16rem)]">
              <ScrollArea className="h-full">
                <div className="space-y-4 pr-4 pt-4">
                  {transcript.map((message) => (
                    <div
                      key={message.id}
                      id={message.id}
                      className={`flex ${message.speaker === "user" ? "justify-start" : "justify-end"} transition-all duration-300`}
                    >
                      <div
                        className={`relative max-w-[70%] px-4 py-3 rounded-lg shadow-sm ${
                          message.speaker === "user"
                            ? "bg-teal-50 border border-teal-200 text-teal-900"
                            : "bg-orange-50 border border-orange-200 text-orange-900"
                        } message-bubble`}
                      >
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

            {/* AI Microphone - Right Side */}
            <div className="flex flex-col items-center gap-4 flex-shrink-0">
              <div className="relative w-32 h-32">
                {/* AI Waveform (Coral/Orange) */}
                <motion.div
                  className="absolute inset-0 rounded-full"
                  animate={{
                    boxShadow: currentSpeaker === "ai" 
                      ? [
                          "0 0 0 0px rgba(251, 146, 60, 0.4)",
                          "0 0 0 20px rgba(251, 146, 60, 0)",
                          "0 0 0 0px rgba(251, 146, 60, 0)",
                        ]
                      : "0 0 0 0px rgba(251, 146, 60, 0)",
                  }}
                  transition={{
                    duration: 1.5,
                    repeat: currentSpeaker === "ai" ? Infinity : 0,
                    ease: "easeOut",
                  }}
                >
                  <div className="absolute inset-4 rounded-full bg-orange-400/20 border-2 border-orange-400/40" />
                </motion.div>

                {/* Center Icon */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full bg-white shadow-lg flex items-center justify-center border-2 border-orange-400/60">
                    <motion.div
                      animate={{ 
                        scale: currentSpeaker === "ai" ? [1, 1.1, 1] : 1 
                      }}
                      transition={{ duration: 1, repeat: currentSpeaker === "ai" ? Infinity : 0 }}
                    >
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
        <div className="max-w-4xl mx-auto flex items-center justify-center">
          {/* Center Controls - Symmetric Layout */}
          <div className="flex items-center gap-4">
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
              </div>

              <ScrollArea className="flex-1 p-6">
                {coachingLoading ? (
                  <div className="text-sm text-teal-200">Analyzing recent turns and guidance materials...</div>
                ) : coachingReport ? (
                  <div className="space-y-6">
                  {/* What You're Doing Well */}
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

                  {/* Weak Signals */}
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

                  {/* Suggested Next Move */}
                  <div>
                    <h3 className="text-lg font-medium text-teal-100 mb-3 flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-blue-400" />
                      Suggested Next Move
                    </h3>
                    <div className="bg-teal-950/50 border border-teal-700 rounded-lg p-4">
                      <p className="text-teal-100 text-sm leading-relaxed">
                        {coachingReport.suggested_next_move}
                      </p>
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
                <Button
                  onClick={handleResumeSimulation}
                  className="w-full bg-teal-600 hover:bg-teal-700 text-white h-12"
                >
                  <Play className="w-5 h-5 mr-2" />
                  Resume Simulation
                </Button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {errorMessage && (
        <div className="fixed bottom-6 right-6 max-w-sm rounded-lg border border-red-200 bg-white px-4 py-3 text-sm text-red-700 shadow-lg">
          {errorMessage}
        </div>
      )}
    </div>
  );
}

async function blobToBase64(blob: Blob) {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
