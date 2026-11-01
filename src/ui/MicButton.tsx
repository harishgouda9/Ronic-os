import { useEffect, useRef, useState } from "react";
import { Mic, Loader2 } from "lucide-react";
import { speechAvailable } from "../kernel/workspaceChrome";
import { secretFor } from "../kernel/liveChat";

type SpeechResultEvent = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: { transcript: string };
    };
  };
};

type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function speechCtor(): (new () => SpeechRec) | null {
  const host = window as Window & { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

export function MicButton({
  disabled,
  onText,
  onError,
}: {
  disabled: boolean;
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [hearing, setHearing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recRef = useRef<SpeechRec | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const accumulatedRef = useRef<string>("");
  const interimRef = useRef<string>("");
  const isStoppingRef = useRef<boolean>(false);
  const ready = speechAvailable();

  useEffect(() => {
    return () => {
      stopAll();
    };
  }, []);

  if (!ready) return null;

  function stopAll() {
    isStoppingRef.current = true;
    try {
      if (recRef.current) {
        recRef.current.onresult = null;
        recRef.current.onerror = null;
        recRef.current.onend = null;
        recRef.current.stop();
        recRef.current = null;
      }
    } catch {}

    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current = null;
      }
    } catch {}

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    setHearing(false);
  }

  async function transcribeAudioBlob(blob: Blob) {
    setTranscribing(true);
    try {
      // Check for available Whisper keys
      const groqKey = secretFor("prov_groq") || "";
      const openaiKey = secretFor("prov_chatgpt") || "";

      if (groqKey) {
        const formData = new FormData();
        formData.append("file", blob, "audio.webm");
        formData.append("model", "whisper-large-v3-turbo");
        const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${groqKey}` },
          body: formData,
        });
        if (res.ok) {
          const data = (await res.json()) as { text?: string };
          if (data.text?.trim()) {
            onText(data.text.trim());
            setTranscribing(false);
            return;
          }
        }
      }

      if (openaiKey) {
        const formData = new FormData();
        formData.append("file", blob, "audio.webm");
        formData.append("model", "whisper-1");
        const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${openaiKey}` },
          body: formData,
        });
        if (res.ok) {
          const data = (await res.json()) as { text?: string };
          if (data.text?.trim()) {
            onText(data.text.trim());
            setTranscribing(false);
            return;
          }
        }
      }

      onError("Speech recognition service was blocked. Add a Groq or OpenAI API key in Apps & providers for instant Whisper voice transcription.");
    } catch (err) {
      onError(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTranscribing(false);
    }
  }

  async function start() {
    isStoppingRef.current = false;
    accumulatedRef.current = "";
    interimRef.current = "";
    audioChunksRef.current = [];

    // 1. First test / request microphone stream
    let stream: MediaStream | null = null;
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.name : "";
      if (msg === "NotAllowedError" || msg === "PermissionDeniedError") {
        onError("The microphone is blocked. Please allow microphone access for this app in OS / browser settings.");
      } else {
        onError("Could not access microphone. Please check your audio input device.");
      }
      return;
    }

    const Ctor = speechCtor();

    // 2. Try Web Speech API if supported
    if (Ctor) {
      try {
        const rec = new Ctor();
        rec.lang = navigator.language || "en-US";
        rec.interimResults = true;
        rec.continuous = true;

        rec.onresult = (event: SpeechResultEvent) => {
          let currentInterim = "";
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            const item = event.results[i];
            const transcript = item?.[0]?.transcript ?? "";
            if (item?.isFinal) {
              const trimmed = transcript.trim();
              if (trimmed) {
                accumulatedRef.current = accumulatedRef.current
                  ? `${accumulatedRef.current} ${trimmed}`
                  : trimmed;
              }
            } else {
              currentInterim += transcript;
            }
          }
          interimRef.current = currentInterim;
        };

        rec.onerror = (event: { error: string }) => {
          if (isStoppingRef.current) return;
          if (event.error === "no-speech" || event.error === "aborted") return;

          // If speech service is not allowed or failed, fall back to MediaRecorder
          if (event.error === "service-not-allowed" || event.error === "network" || event.error === "audio-capture") {
            try {
              rec.stop();
            } catch {}
            recRef.current = null;
            if (stream) {
              startMediaRecorder(stream);
            } else {
              onError("Speech service not reachable. Type your message or connect a Groq/OpenAI key for Whisper.");
              stopAll();
            }
            return;
          }

          if (event.error === "not-allowed") {
            onError("Microphone access is blocked. Allow it in settings, then try again.");
            stopAll();
            return;
          }

          onError(`Speech recognition error: ${event.error}`);
          stopAll();
        };

        rec.onend = () => {
          if (isStoppingRef.current) return;
          // If ended prematurely, restart if still supposed to be listening
          try {
            rec.start();
          } catch {
            // flushed in stop()
          }
        };

        recRef.current = rec;
        rec.start();
        setHearing(true);
        return;
      } catch {
        // Fall back to MediaRecorder if Ctor.start() throws
      }
    }

    // 3. Fallback: MediaRecorder
    if (stream) {
      startMediaRecorder(stream);
    } else {
      onError("Speech recognition is not available in this environment.");
    }
  }

  function startMediaRecorder(stream: MediaStream) {
    try {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";

      const options = mimeType ? { mimeType } : undefined;
      const mediaRecorder = new MediaRecorder(stream, options);
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (audioChunksRef.current.length > 0) {
          const blob = new Blob(audioChunksRef.current, { type: mimeType || "audio/webm" });
          void transcribeAudioBlob(blob);
        }
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(250);
      setHearing(true);
    } catch (err) {
      onError(`Failed to start audio recording: ${err instanceof Error ? err.message : String(err)}`);
      stopAll();
    }
  }

  function stop() {
    isStoppingRef.current = true;
    setHearing(false);

    // If using Web Speech API: collect final and interim transcript
    if (recRef.current) {
      try {
        recRef.current.stop();
      } catch {}
      recRef.current = null;

      const finalCollected = [accumulatedRef.current.trim(), interimRef.current.trim()]
        .filter(Boolean)
        .join(" ")
        .trim();

      if (finalCollected) {
        onText(finalCollected);
      }
    }

    // If using MediaRecorder: stop it, which triggers onstop -> transcribeAudioBlob
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        mediaRecorderRef.current.stop();
      } catch {}
      mediaRecorderRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
  }

  return (
    <button
      type="button"
      className={`mic-btn ${hearing ? "on" : ""} ${transcribing ? "busy" : ""}`}
      aria-label={transcribing ? "Transcribing speech…" : hearing ? "Stop microphone" : "Speak (voice dictation)"}
      title={transcribing ? "Transcribing speech…" : hearing ? "Listening… Click to finish" : "Click to speak"}
      aria-pressed={hearing}
      disabled={disabled || transcribing}
      data-mic
      onClick={() => {
        if (hearing) {
          stop();
        } else {
          void start();
        }
      }}
    >
      {transcribing ? <Loader2 size={16} className="spin" /> : <Mic size={16} />}
    </button>
  );
}
