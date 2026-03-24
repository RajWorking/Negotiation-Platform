import type { VoiceProfile } from "./types";

type SpeechRecognitionConstructor = new () => SpeechRecognition;

declare global {
  interface Window {
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    SpeechRecognition?: SpeechRecognitionConstructor;
  }

  interface SpeechRecognition extends EventTarget {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start(): void;
    stop(): void;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: ((event: Event) => void) | null;
    onend: (() => void) | null;
  }

  interface SpeechRecognitionEvent extends Event {
    resultIndex: number;
    results: SpeechRecognitionResultList;
  }
}

function pickVoice(voices: SpeechSynthesisVoice[], voiceProfile: VoiceProfile) {
  const preferred = voices.find((voice) => {
    const normalized = `${voice.name} ${voice.lang}`.toLowerCase();
    return [voiceProfile.gender, voiceProfile.accent, voiceProfile.preset]
      .filter(Boolean)
      .every((part) => normalized.includes(String(part).toLowerCase()));
  });
  return preferred ?? voices[0] ?? null;
}

export function createSpeechRecognition() {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) {
    return null;
  }
  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  return recognition;
}

export function speakWithBrowserVoice(params: {
  text: string;
  voiceProfile: VoiceProfile;
  onStart?: () => void;
  onEnd?: () => void;
}) {
  if (!("speechSynthesis" in window)) {
    params.onStart?.();
    params.onEnd?.();
    return null;
  }

  const utterance = new SpeechSynthesisUtterance(params.text);
  utterance.onstart = () => params.onStart?.();
  utterance.onend = () => params.onEnd?.();

  const applyVoice = () => {
    const voice = pickVoice(window.speechSynthesis.getVoices(), params.voiceProfile);
    if (voice) {
      utterance.voice = voice;
    }
  };

  applyVoice();
  if (!utterance.voice) {
    window.speechSynthesis.onvoiceschanged = () => applyVoice();
  }

  window.speechSynthesis.speak(utterance);
  return utterance;
}

export function stopSpeaking() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

export function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}
