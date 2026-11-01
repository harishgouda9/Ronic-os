import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from "mediabunny";

export interface MediaTrackInfo {
  codec: string;
  width?: number;
  height?: number;
  channels?: number;
  sampleRate?: number;
}

export interface MediaInfo {
  container: string;
  durationSec: number;
  video?: MediaTrackInfo;
  audio?: MediaTrackInfo;
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Reads container/duration/track info with mediabunny — all local, no upload. */
export async function inspectMedia(file: Blob): Promise<MediaInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const format = await input.getFormat();
  const durationSec = await input.computeDuration();
  const info: MediaInfo = {
    container: String((format as { name?: string }).name ?? "unknown"),
    durationSec,
  };
  try {
    const video = await input.getPrimaryVideoTrack();
    if (video) {
      info.video = {
        codec: String(video.codec),
        width: num((video as unknown as { codedWidth?: number }).codedWidth) ?? num((video as unknown as { displayWidth?: number }).displayWidth),
        height: num((video as unknown as { codedHeight?: number }).codedHeight) ?? num((video as unknown as { displayHeight?: number }).displayHeight),
      };
    }
  } catch {
    /* video track optional */
  }
  try {
    const audio = await input.getPrimaryAudioTrack();
    if (audio) {
      info.audio = {
        codec: String(audio.codec),
        channels: num(audio.numberOfChannels),
        sampleRate: num(audio.sampleRate),
      };
    }
  } catch {
    /* audio track optional */
  }
  return info;
}

export interface ConvertOptions {
  container: "mp4" | "webm";
  trimStart?: number;
  trimEnd?: number;
  scaleHeight?: number;
  onProgress?: (progress: number) => void;
}

/**
 * Converts/transcodes/trim via mediabunny's Conversion pipeline (WebCodecs,
 * hardware-accelerated in this WebView). Returns the result as a Blob.
 */
export async function convertMedia(file: Blob, options: ConvertOptions): Promise<Blob> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const output = new Output({
    format: options.container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const trim =
    options.trimStart !== undefined || options.trimEnd !== undefined
      ? {
          start: options.trimStart !== undefined ? Math.max(0, options.trimStart) : undefined,
          end: options.trimEnd !== undefined && options.trimEnd > 0 ? options.trimEnd : undefined,
        }
      : undefined;
  const video =
    options.scaleHeight !== undefined && options.scaleHeight > 0
      ? { height: options.scaleHeight, fit: "fill" as const }
      : undefined;
  const conversion = await Conversion.init({ input, output, trim, video });
  conversion.onProgress = (progress) => {
    options.onProgress?.(Math.min(0.99, progress));
  };
  await conversion.execute();
  options.onProgress?.(1);
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error("the conversion produced no data");
  return new Blob([buffer], { type: options.container === "mp4" ? "video/mp4" : "video/webm" });
}

/** First-frame thumbnail via a seeked <video> element + canvas. */
export async function videoThumbnail(file: Blob, atSec = 1, width = 320): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "metadata";
    video.src = url;
    const cleanup = (result: string | null) => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      resolve(result);
    };
    const fail = window.setTimeout(() => cleanup(null), 8000);
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(atSec, Math.max(0, (video.duration || 1) - 0.1));
    };
    video.onseeked = () => {
      window.clearTimeout(fail);
      try {
        const height = Math.max(1, Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * width));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return cleanup(null);
        ctx.drawImage(video, 0, 0, width, height);
        cleanup(canvas.toDataURL("image/jpeg", 0.82));
      } catch {
        cleanup(null);
      }
    };
    video.onerror = () => {
      window.clearTimeout(fail);
      cleanup(null);
    };
  });
}
