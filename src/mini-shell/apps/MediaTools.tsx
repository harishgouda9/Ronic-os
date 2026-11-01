import { useEffect, useRef, useState } from "react";
import { Download, Loader, Scissors, WandSparkles } from "lucide-react";
import { blobToBase64, errorMessage, formatBytes, ipc } from "../ipc";
import { convertMedia, inspectMedia, videoThumbnail, type MediaInfo } from "../media";

/**
 * Built on mediabunny (MPL-2.0): local, hardware-accelerated WebCodecs
 * conversion — inspect, convert, and trim media without leaving the mini
 * computer. Nothing is uploaded.
 */
export function MediaTools({ blob, name, size, root, path, onSaved, botId }: { blob: Blob; name: string; size: number; ext?: string; root: string; path: string; onSaved?: () => void; botId?: string }) {
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<{ url: string; name: string; blob: Blob } | null>(null);
  const [trimStart, setTrimStart] = useState("");
  const [trimEnd, setTrimEnd] = useState("");
  const [scaleHeight, setScaleHeight] = useState("");
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const mediaInfo = await inspectMedia(blob);
        if (!alive) return;
        setInfo(mediaInfo);
        const isVideo = mediaInfo.video !== undefined;
        if (isVideo) {
          const image = await videoThumbnail(blob, Math.min(1, mediaInfo.durationSec / 2));
          if (alive) setThumb(image);
        }
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    })();
    return () => {
      alive = false;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [blob]);

  const run = async (container: "mp4" | "webm") => {
    setError(null);
    setResult(null);
    setProgress(0);
    try {
      const start = trimStart ? Number(trimStart) : undefined;
      const end = trimEnd ? Number(trimEnd) : undefined;
      const height = scaleHeight ? Number(scaleHeight) : undefined;
      const converted = await convertMedia(blob, {
        container,
        trimStart: Number.isFinite(start) ? start : undefined,
        trimEnd: Number.isFinite(end) ? end : undefined,
        scaleHeight: Number.isFinite(height) && height ? height : undefined,
        onProgress: setProgress,
      });
      const stem = name.replace(/\.[^.]+$/, "");
      const outName = `${stem}-${container === "mp4" ? "converted" : "webm"}.${container}`;
      const url = URL.createObjectURL(converted);
      urlRef.current = url;
      setResult({ url, name: outName, blob: converted });
      const saveTo = path.replace(/[^/]+$/, outName);
      await ipc.fsWriteBytes(root, saveTo, await blobToBase64(converted), botId);
      onSaved?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const seconds = info?.durationSec ? `${info.durationSec.toFixed(1)}s` : "—";

  return (
    <div className="msh-media">
      {thumb ? <img className="msh-media-thumb" src={thumb} alt={`${name} preview`} /> : null}
      <p className="msh-detail-meta">
        {info ? (
          <>
            {info.container} · {seconds} · {formatBytes(size)}
            {info.video ? ` · ${info.video.codec}${info.video.width ? ` ${info.video.width}×${info.video.height}` : ""}` : ""}
            {info.audio ? ` · ${info.audio.codec}` : ""}
          </>
        ) : (
          "Reading media…"
        )}
      </p>
      <div className="msh-media-row">
        <label>
          Trim from <input inputMode="decimal" placeholder="0" value={trimStart} onChange={(event) => setTrimStart(event.target.value)} aria-label="Trim start seconds" />
        </label>
        <label>
          to <input inputMode="decimal" placeholder={info ? seconds.replace("s", "") : "end"} value={trimEnd} onChange={(event) => setTrimEnd(event.target.value)} aria-label="Trim end seconds" />
        </label>
        <label>
          height <input inputMode="numeric" placeholder="keep" value={scaleHeight} onChange={(event) => setScaleHeight(event.target.value)} aria-label="Output height pixels" />
        </label>
      </div>
      <div className="msh-media-actions">
        <button className="msh-save-btn" disabled={progress !== null} onClick={() => void run("mp4")}>
          <WandSparkles size={12} aria-hidden /> Convert / trim → MP4
        </button>
        <button className="msh-save-btn" disabled={progress !== null} onClick={() => void run("webm")}>
          <Scissors size={12} aria-hidden /> → WebM
        </button>
      </div>
      {progress !== null ? (
        <p className="msh-media-progress" role="status">
          <Loader size={12} className="msh-spin" aria-hidden /> Working… {Math.round(progress * 100)}%
        </p>
      ) : null}
      {result ? (
        <div className="msh-media-result">
          <video controls src={result.url} className="msh-media-video" />
          <div className="msh-media-actions">
            <a className="msh-save-btn" href={result.url} download={result.name}>
              <Download size={12} aria-hidden /> Save {result.name} ({formatBytes(result.blob.size)})
            </a>
            <span className="msh-detail-meta">Saved next to the original too.</span>
          </div>
        </div>
      ) : null}
      {error ? <p className="msh-error">{error}</p> : null}
    </div>
  );
}
