import { useRef, useState } from "react";
import { Mic } from "lucide-react";
import { speechAvailable } from "../kernel/workspaceChrome";

type SpeechResultEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function speechCtor(): (new () => SpeechRec) | null {
  const host = window as Window & { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
}

export function MicButton({ disabled, onText, onError }: { disabled: boolean; onText: (text: string) => void; onError: (message: string) => void }) {
  const [hearing, setHearing] = useState(false);
  const recRef = useRef<SpeechRec | null>(null);
  const ready = speechAvailable();

  if (!ready) return null;

  function stop() {
    recRef.current?.stop();
    recRef.current = null;
    setHearing(false);
  }

  function start() {
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    let sent = false;
    rec.lang = navigator.language || "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (event) => {
      if (sent) return;
      const text = Array.from(event.results).map((row) => row[0]?.transcript ?? "").join(" ").trim();
      if (!text) return;
      sent = true;
      onText(text);
    };
    rec.onerror = (event) => {
      setHearing(false);
      recRef.current = null;
      if (event.error === "aborted" || event.error === "no-speech") return;
      if (event.error === "not-allowed" || event.error === "audio-capture" || event.error === "service-not-allowed") {
        onError("The microphone is blocked. Allow it for this window, then try again.");
        return;
      }
      onError("Speech did not start. Type the message instead.");
    };
    rec.onend = () => {
      recRef.current = null;
      setHearing(false);
    };
    recRef.current = rec;
    setHearing(true);
    try {
      rec.start();
    } catch {
      setHearing(false);
      recRef.current = null;
      onError("Speech did not start. Type the message instead.");
    }
  }

  return (
    <button
      type="button"
      className={`mic-btn ${hearing ? "on" : ""}`}
      aria-label={hearing ? "Stop microphone" : "Speak"}
      aria-pressed={hearing}
      disabled={disabled}
      data-mic
      onClick={() => hearing ? stop() : start()}
    >
      <Mic size={16} />
    </button>
  );
}
