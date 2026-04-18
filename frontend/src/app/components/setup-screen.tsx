import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { 
  Flame, 
  Scale, 
  Circle, 
  Handshake, 
  ShieldAlert, 
  BrainCircuit,
  Upload,
  Volume2,
  X,
  FileText
} from "lucide-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { Checkbox } from "./ui/checkbox";
import { Slider } from "./ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { clearSetupDraft, saveActiveSession, saveSetupDraft, loadSetupDraft } from "../lib/storage";
import { createSession, fetchVoices, sliderValueToMode, startSession, uploadDocuments } from "../lib/api";
import { fileToBase64 } from "../lib/speech";
import type { VoiceOption } from "../lib/types";

interface UploadStatus {
  name: string;
  status: "pending" | "uploading" | "ready" | "error";
  message?: string;
}

const TONE_OPTIONS = [
  { value: "aggressive", label: "Aggressive", icon: Flame },
  { value: "dismissive", label: "Dismissive", icon: ShieldAlert },
  { value: "neutral", label: "Neutral / Balanced", icon: Scale },
  { value: "cooperative", label: "Cooperative", icon: Handshake },
  { value: "fearful", label: "Fearful / Defensive", icon: ShieldAlert },
  { value: "analytical", label: "Analytical / Logical", icon: BrainCircuit },
  { value: "custom", label: "Custom", icon: Circle },
];

const COACHING_FOCUSES = [
  "Persuasion & Framing",
  "Confidence & Presence",
  "Anchoring & Numbers",
  "Power Dynamics",
  "Emotional Control",
  "Domain Expertise",
];

export function SetupScreen() {
  const navigate = useNavigate();
  const [situation, setSituation] = useState("");
  const [tone, setTone] = useState("neutral");
  const [customTone, setCustomTone] = useState("");
  const [coachingFocuses, setCoachingFocuses] = useState<string[]>([]);
  const [voiceId, setVoiceId] = useState("af_bella");
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [adviceSpeed, setAdviceSpeed] = useState([50]);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [uploadStatuses, setUploadStatuses] = useState<Record<string, UploadStatus>>({});

  const maxChars = 500;
  const charCount = situation.length;
  const selectedTone = tone === "custom" ? customTone.trim() : tone;
  const mode = sliderValueToMode(adviceSpeed[0]);
  const canStart = Boolean(situation.trim() && selectedTone);

  // Load available voices from backend
  useEffect(() => {
    fetchVoices()
      .then(setVoices)
      .catch(() => {
        // Fallback voice list if backend is unreachable
        setVoices([
          { id: "af_bella", label: "Bella", description: "American female, warm", accent: "american", gender: "female" },
          { id: "am_adam", label: "Adam", description: "American male, confident", accent: "american", gender: "male" },
          { id: "bf_emma", label: "Emma", description: "British female, professional", accent: "british", gender: "female" },
          { id: "bm_george", label: "George", description: "British male, authoritative", accent: "british", gender: "male" },
        ]);
      });
  }, []);

  useEffect(() => {
    const draft = loadSetupDraft();
    if (!draft) {
      return;
    }
    setSituation(draft.situation);
    setTone(draft.tone);
    setCustomTone(draft.customTone);
    setCoachingFocuses(draft.coachingFocuses);
    if (draft.voiceId) {
      setVoiceId(draft.voiceId);
    }
    setAdviceSpeed([draft.adviceSpeed]);
  }, []);

  useEffect(() => {
    saveSetupDraft({
      situation,
      tone,
      customTone,
      coachingFocuses,
      voiceId,
      adviceSpeed: adviceSpeed[0],
    });
  }, [situation, tone, customTone, coachingFocuses, voiceId, adviceSpeed]);

  const handleCoachingFocusToggle = (focus: string) => {
    setCoachingFocuses((prev) =>
      prev.includes(focus)
        ? prev.filter((f) => f !== focus)
        : [...prev, focus]
    );
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = Array.from(e.target.files);
      setUploadedFiles((prev) => [...prev, ...newFiles]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    if (e.dataTransfer.files) {
      const newFiles = Array.from(e.dataTransfer.files);
      setUploadedFiles((prev) => [...prev, ...newFiles]);
    }
  };

  const removeFile = (index: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleStartSimulation = async () => {
    if (!canStart || isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError("");

    try {
      const selectedVoice = voices.find((v) => v.id === voiceId);
      const voiceProfile = {
        preset: voiceId,
        gender: selectedVoice?.gender,
        accent: selectedVoice?.accent,
      };

      const session = await createSession({
        situationDescription: situation.trim(),
        partnerTone: selectedTone,
        voiceProfile,
        mode,
        coachingFocuses,
      });

      if (uploadedFiles.length > 0) {
        for (const file of uploadedFiles) {
          setUploadStatuses((prev) => ({
            ...prev,
            [file.name]: { name: file.name, status: "uploading" },
          }));
          try {
            const base64 = await fileToBase64(file);
            await uploadDocuments(session.session_id, [{ fileName: file.name, base64 }]);
            setUploadStatuses((prev) => ({
              ...prev,
              [file.name]: { name: file.name, status: "ready", message: "Indexed for coaching" },
            }));
          } catch (error) {
            setUploadStatuses((prev) => ({
              ...prev,
              [file.name]: {
                name: file.name,
                status: "error",
                message: error instanceof Error ? error.message : "Upload failed",
              },
            }));
            throw error;
          }
        }
      }

      await startSession(session.session_id);
      clearSetupDraft();
      saveActiveSession({
        sessionId: session.session_id,
        situation: situation.trim(),
        tone: selectedTone,
        mode,
        voiceProfile,
      });

      navigate("/simulation", {
        state: {
          sessionId: session.session_id,
          situation: situation.trim(),
          tone: selectedTone,
          mode,
          voiceProfile,
        },
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Unable to start the session");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-[1000px] bg-white rounded-xl shadow-lg p-8">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold text-slate-900 mb-2">
            Prepare Your Simulation
          </h1>
          <p className="text-slate-600">
            Configure your practice scenario and coaching preferences
          </p>
        </div>

        <div className="grid grid-cols-2 gap-8">
          {/* LEFT COLUMN */}
          <div className="space-y-8">
            {/* Situation Description */}
            <div className="space-y-3">
              <Label htmlFor="situation" className="text-base font-medium text-slate-900">
                Situation Description
              </Label>
              <div className="relative">
                <Textarea
                  id="situation"
                  value={situation}
                  onChange={(e) => setSituation(e.target.value.slice(0, maxChars))}
                  placeholder="Describe the situation you want to practice (e.g., negotiating rent with a stubborn landlord, salary discussion after promotion, pitching a startup to a VC)."
                  className="min-h-[140px] text-base resize-none rounded-lg border-slate-300 focus:border-indigo-500 focus:ring-indigo-500"
                />
                <div className="absolute bottom-3 right-3 text-sm text-slate-500">
                  {charCount}/{maxChars}
                </div>
              </div>
            </div>

            {/* Opponent Tone */}
            <div className="space-y-3">
              <Label htmlFor="tone" className="text-base font-medium text-slate-900">
                Opponent Tone
              </Label>
              <Select value={tone} onValueChange={setTone}>
                <SelectTrigger className="w-full rounded-lg border-slate-300 focus:border-indigo-500 focus:ring-indigo-500">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TONE_OPTIONS.map((option) => {
                    const Icon = option.icon;
                    return (
                      <SelectItem key={option.value} value={option.value}>
                        <div className="flex items-center gap-2">
                          <Icon className="w-4 h-4 text-slate-600" />
                          <span>{option.label}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {tone === "custom" && (
                <input
                  type="text"
                  value={customTone}
                  onChange={(e) => setCustomTone(e.target.value)}
                  placeholder="Describe custom tone..."
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              )}
            </div>

            {/* AI Voice */}
            <div className="space-y-3">
              <Label className="text-base font-medium text-slate-900">
                AI Voice
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {voices.map((voice) => (
                  <button
                    key={voice.id}
                    type="button"
                    onClick={() => setVoiceId(voice.id)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                      voiceId === voice.id
                        ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500"
                        : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                    }`}
                  >
                    <Volume2 className={`w-4 h-4 flex-shrink-0 ${
                      voiceId === voice.id ? "text-indigo-600" : "text-slate-400"
                    }`} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800">{voice.label}</div>
                      <div className="text-xs text-slate-500 truncate">{voice.description}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN */}
          <div className="space-y-8">
            {/* Coaching Focus */}
            <div className="space-y-3">
              <Label className="text-base font-medium text-slate-900">
                Coaching Focus
              </Label>
              <p className="text-sm text-slate-600 mb-3">
                What kind of help do you want?
              </p>
              <div className="space-y-2">
                {COACHING_FOCUSES.map((focus) => (
                  <div key={focus} className="flex items-center space-x-2">
                    <Checkbox
                      id={focus}
                      checked={coachingFocuses.includes(focus)}
                      onCheckedChange={() => handleCoachingFocusToggle(focus)}
                      className="border-slate-300 data-[state=checked]:bg-indigo-600 data-[state=checked]:border-indigo-600"
                    />
                    <Label
                      htmlFor={focus}
                      className="text-sm font-normal text-slate-700 cursor-pointer"
                    >
                      {focus}
                    </Label>
                  </div>
                ))}
              </div>
            </div>

            {/* Upload Reference Materials */}
            <div className="space-y-3">
              <Label className="text-base font-medium text-slate-900">
                Upload Reference Materials
              </Label>
              <input
                type="file"
                multiple
                onChange={handleFileChange}
                accept=".pdf,.doc,.docx,.txt"
                className="hidden"
                id="file-upload"
              />
              <label
                htmlFor="file-upload"
                className={`block border-2 border-dashed rounded-lg p-6 text-center hover:border-indigo-400 transition-colors cursor-pointer ${
                  isDragging ? 'border-indigo-400 bg-indigo-50' : 'border-slate-300'
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                <p className="text-sm text-slate-600">
                  Upload books, notes, frameworks, or job descriptions to guide coaching.
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Drag and drop files here, or click to browse
                </p>
              </label>
              {uploadedFiles.length > 0 && (
                <div className="mt-4 space-y-2">
                  <Label className="text-sm font-medium text-slate-700">
                    Uploaded Files ({uploadedFiles.length})
                  </Label>
                  <div className="space-y-2">
                    {uploadedFiles.map((file, index) => (
                      <div
                        key={index}
                        className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3 py-2"
                      >
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <FileText className="w-4 h-4 text-slate-600 flex-shrink-0" />
                          <span className="text-sm text-slate-700 truncate">{file.name}</span>
                          <span className="text-xs text-slate-500 flex-shrink-0">
                            ({(file.size / 1024).toFixed(1)} KB)
                          </span>
                        </div>
                        <button
                          onClick={() => removeFile(index)}
                          className="text-slate-400 hover:text-red-500 transition-colors flex-shrink-0 ml-2"
                          type="button"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Advice Speed vs Depth Slider */}
            <div className="space-y-4">
              <Label className="text-base font-medium text-slate-900">
                Advice Speed vs Depth
              </Label>
              <div className="space-y-2">
                <Slider
                  value={adviceSpeed}
                  onValueChange={setAdviceSpeed}
                  max={100}
                  step={1}
                  className="w-full"
                />
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Fast, reactive advice</span>
                  <span>Slower, strategic advice</span>
                </div>
                <div className="text-xs text-slate-500">
                  Active mode: <span className="font-medium text-slate-700 capitalize">{mode}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {uploadedFiles.length > 0 && Object.keys(uploadStatuses).length > 0 && (
          <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-medium text-slate-800 mb-2">Upload status</p>
            <div className="space-y-2">
              {uploadedFiles.map((file) => {
                const status = uploadStatuses[file.name];
                if (!status) {
                  return null;
                }
                return (
                  <div key={file.name} className="flex items-center justify-between text-sm text-slate-700">
                    <span className="truncate">{file.name}</span>
                    <span className="capitalize text-slate-500">{status.message ?? status.status}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {submitError && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {submitError}
          </div>
        )}

        {/* Start Button - Full Width at Bottom */}
        <div className="pt-8 mt-8 border-t border-slate-200">
          <Button
            onClick={handleStartSimulation}
            disabled={!canStart || isSubmitting}
            className="w-full h-14 text-lg font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Starting Simulation..." : "Start Simulation"}
          </Button>
        </div>
      </div>
    </div>
  );
}
