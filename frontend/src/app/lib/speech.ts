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

// Mapping from our voice profile values to keywords commonly found in
// browser TTS voice names/langs. We score each voice against these and
// pick the best match. This is inherently best-effort since available
// voices vary wildly across browsers and OSes.
const GENDER_HINTS: Record<string, string[]> = {
  male: ["male", "daniel", "james", "alex", "david", "mark", "tom", "guy"],
  female: ["female", "samantha", "victoria", "karen", "fiona", "zira", "susan", "kate"],
  neutral: [],
};

const ACCENT_HINTS: Record<string, string[]> = {
  american: ["en-us", "united states", "american"],
  british: ["en-gb", "en_gb", "united kingdom", "british", "daniel"],
  australian: ["en-au", "en_au", "australia"],
  indian: ["en-in", "en_in", "india"],
  "east-asian": ["zh", "ja", "ko", "chinese", "japanese", "korean"],
  neutral: ["en-us", "en-gb", "en"],
};

const AGE_HINTS: Record<string, string[]> = {
  young: ["junior", "young"],
  middle: [],
  senior: ["senior", "old"],
};

function scoreVoice(voice: SpeechSynthesisVoice, profile: VoiceProfile): number {
  const haystack = `${voice.name} ${voice.lang}`.toLowerCase();
  let score = 0;

  // Prefer English voices
  if (haystack.includes("en")) score += 1;

  const genderKeys = GENDER_HINTS[profile.gender ?? "neutral"] ?? [];
  for (const hint of genderKeys) {
    if (haystack.includes(hint)) { score += 3; break; }
  }

  const accentKeys = ACCENT_HINTS[profile.accent ?? "neutral"] ?? [];
  for (const hint of accentKeys) {
    if (haystack.includes(hint)) { score += 2; break; }
  }

  const ageKeys = AGE_HINTS[profile.age ?? "middle"] ?? [];
  for (const hint of ageKeys) {
    if (haystack.includes(hint)) { score += 1; break; }
  }

  return score;
}

function pickVoice(voices: SpeechSynthesisVoice[], profile: VoiceProfile): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;

  const scored = voices.map((voice) => ({ voice, score: scoreVoice(voice, profile) }));
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best.score === 0) {
    // No profile match at all — fall back to first English voice or first available
    const englishFallback = voices.find((v) => v.lang.startsWith("en"));
    return englishFallback ?? voices[0];
  }
  return best.voice;
}

// ---------------------------------------------------------------------------
// Raw PCM mic capture — sends 16kHz mono int16 chunks, no webm encoding
// ---------------------------------------------------------------------------
export interface PcmMicCapture {
  start: () => void;
  stop: () => void;
}

export function createPcmMicCapture(
  stream: MediaStream,
  onChunk: (base64: string) => void,
  intervalMs = 500,
): PcmMicCapture {
  const audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(stream);

  // ScriptProcessorNode is deprecated but universally supported.
  // bufferSize=4096 at 16kHz ≈ 256ms per callback.
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  let buffer: Float32Array[] = [];
  let sampleCount = 0;
  const samplesPerInterval = Math.floor((16000 * intervalMs) / 1000);
  let started = false;

  processor.onaudioprocess = (e) => {
    if (!started) return;
    const input = e.inputBuffer.getChannelData(0);
    buffer.push(new Float32Array(input));
    sampleCount += input.length;

    if (sampleCount >= samplesPerInterval) {
      // Merge buffer into single int16 array
      const merged = new Float32Array(sampleCount);
      let offset = 0;
      for (const chunk of buffer) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      const int16 = new Int16Array(merged.length);
      for (let i = 0; i < merged.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, Math.round(merged[i] * 32767)));
      }
      // Base64 encode
      const bytes = new Uint8Array(int16.buffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      onChunk(btoa(binary));
      buffer = [];
      sampleCount = 0;
    }
  };

  source.connect(processor);
  processor.connect(audioContext.destination);

  return {
    start() { started = true; },
    stop() {
      started = false;
      processor.disconnect();
      source.disconnect();
      void audioContext.close();
    },
  };
}

export function createSpeechRecognition(): SpeechRecognition | null {
  const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!Recognition) return null;

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
}): SpeechSynthesisUtterance | null {
  if (!("speechSynthesis" in window)) {
    console.warn("[speech] Browser does not support SpeechSynthesis — skipping TTS");
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

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

// ---------------------------------------------------------------------------
// Server TTS audio player — plays PCM chunks streamed from the backend
// ---------------------------------------------------------------------------
export interface ServerAudioPlayer {
  feedChunk: (base64: string, sampleRate: number) => void;
  markEnd: () => void;
  onPlaybackEnd: (callback: () => void) => void;
  stop: () => void;
}

export function createServerAudioPlayer(): ServerAudioPlayer {
  const audioContext = new AudioContext();
  const queue: AudioBuffer[] = [];
  let isPlaying = false;
  let endMarked = false;
  let endCallback: (() => void) | null = null;
  let currentSource: AudioBufferSourceNode | null = null;
  let nextStartTime = 0;

  function scheduleNext() {
    if (queue.length === 0) {
      isPlaying = false;
      if (endMarked && endCallback) {
        endCallback();
        endCallback = null;
      }
      return;
    }

    isPlaying = true;
    const buffer = queue.shift()!;
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const startTime = Math.max(audioContext.currentTime, nextStartTime);
    source.start(startTime);
    nextStartTime = startTime + buffer.duration;
    currentSource = source;

    source.onended = () => {
      currentSource = null;
      scheduleNext();
    };
  }

  return {
    feedChunk(base64: string, sampleRate: number) {
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Convert int16 PCM to float32 for Web Audio API
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      const audioBuffer = audioContext.createBuffer(1, float32.length, sampleRate);
      audioBuffer.copyToChannel(float32, 0);
      queue.push(audioBuffer);

      if (!isPlaying) {
        scheduleNext();
      }
    },

    markEnd() {
      endMarked = true;
      // If nothing is playing and queue is empty, fire immediately
      if (!isPlaying && queue.length === 0 && endCallback) {
        endCallback();
        endCallback = null;
      }
    },

    onPlaybackEnd(callback: () => void) {
      endCallback = callback;
    },

    stop() {
      queue.length = 0;
      endMarked = false;
      if (currentSource) {
        try { currentSource.stop(); } catch { /* already stopped */ }
        currentSource = null;
      }
      isPlaying = false;
      nextStartTime = 0;
    },
  };
}

export function fileToBase64(file: File): Promise<string> {
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
