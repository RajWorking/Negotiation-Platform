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
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Slider } from "./ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { clearSetupDraft, saveActiveSession, saveSetupDraft, loadSetupDraft } from "../lib/storage";
import { createSession, sliderValueToMode, startSession, uploadDocuments } from "../lib/api";
import { fileToBase64 } from "../lib/speech";

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
  const [gender, setGender] = useState("neutral");
  const [age, setAge] = useState("middle");
  const [accent, setAccent] = useState("neutral");
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

  useEffect(() => {
    const draft = loadSetupDraft();
    if (!draft) {
      return;
    }
    setSituation(draft.situation);
    setTone(draft.tone);
    setCustomTone(draft.customTone);
    setCoachingFocuses(draft.coachingFocuses);
    setGender(draft.gender);
    setAge(draft.age);
    setAccent(draft.accent);
    setAdviceSpeed([draft.adviceSpeed]);
  }, []);

  useEffect(() => {
    saveSetupDraft({
      situation,
      tone,
      customTone,
      coachingFocuses,
      gender,
      age,
      accent,
      adviceSpeed: adviceSpeed[0],
    });
  }, [situation, tone, customTone, coachingFocuses, gender, age, accent, adviceSpeed]);

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
      const voiceProfile = {
        preset: `${age}_${gender}_${accent}`,
        gender,
        age,
        accent,
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

            {/* AI Voice Demographics */}
            <div className="space-y-4">
              <Label className="text-base font-medium text-slate-900">
                AI Voice Demographics
              </Label>
              
              <div className="grid grid-cols-2 gap-6">
                {/* Left: Gender and Age */}
                <div className="space-y-4">
                  {/* Gender */}
                  <div className="space-y-2">
                    <Label className="text-sm text-slate-700">Gender</Label>
                    <RadioGroup value={gender} onValueChange={setGender}>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="male" id="male" />
                        <Label htmlFor="male" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                          <Volume2 className="w-3 h-3 text-slate-400" />
                          Male
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="female" id="female" />
                        <Label htmlFor="female" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                          <Volume2 className="w-3 h-3 text-slate-400" />
                          Female
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="neutral" id="gender-neutral" />
                        <Label htmlFor="gender-neutral" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                          <Volume2 className="w-3 h-3 text-slate-400" />
                          Neutral
                        </Label>
                      </div>
                    </RadioGroup>
                  </div>

                  {/* Age */}
                  <div className="space-y-2">
                    <Label className="text-sm text-slate-700">Age</Label>
                    <RadioGroup value={age} onValueChange={setAge}>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="young" id="young" />
                        <Label htmlFor="young" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                          <Volume2 className="w-3 h-3 text-slate-400" />
                          Young
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="middle" id="middle" />
                        <Label htmlFor="middle" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                          <Volume2 className="w-3 h-3 text-slate-400" />
                          Middle-aged
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="senior" id="senior" />
                        <Label htmlFor="senior" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                          <Volume2 className="w-3 h-3 text-slate-400" />
                          Senior
                        </Label>
                      </div>
                    </RadioGroup>
                  </div>
                </div>

                {/* Right: Accent */}
                <div className="space-y-2">
                  <Label className="text-sm text-slate-700">Accent</Label>
                  <RadioGroup value={accent} onValueChange={setAccent}>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="american" id="american" />
                      <Label htmlFor="american" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                        <Volume2 className="w-3 h-3 text-slate-400" />
                        American
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="british" id="british" />
                      <Label htmlFor="british" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                        <Volume2 className="w-3 h-3 text-slate-400" />
                        British
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="australian" id="australian" />
                      <Label htmlFor="australian" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                        <Volume2 className="w-3 h-3 text-slate-400" />
                        Australian
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="indian" id="indian" />
                      <Label htmlFor="indian" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                        <Volume2 className="w-3 h-3 text-slate-400" />
                        Indian
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="east-asian" id="east-asian" />
                      <Label htmlFor="east-asian" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                        <Volume2 className="w-3 h-3 text-slate-400" />
                        East Asian
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="neutral" id="accent-neutral" />
                      <Label htmlFor="accent-neutral" className="font-normal text-sm cursor-pointer flex items-center gap-1">
                        <Volume2 className="w-3 h-3 text-slate-400" />
                        Neutral Global
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
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
