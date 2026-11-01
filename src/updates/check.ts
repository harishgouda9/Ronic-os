import { invokeRaw, isTauri } from "../api";
import { feedAddress, pickUpdate, shouldNotify, type UpdateChannel, type UpdateStatus } from "./feed";

export type UpdateAnnouncement = { status: UpdateStatus; notify: boolean };

type FeedSources = {
  localPath: string;
  localText: string | null;
  localError: string | null;
  remoteText: string | null;
  remoteError: string | null;
};

export async function runUpdateCheck(input: {
  installed: string;
  channel: UpdateChannel;
  feedUrl: string;
  announce: boolean;
  explicit: boolean;
  dismissed: string[];
}): Promise<UpdateStatus> {
  const status = await loadUpdateStatus(input.installed, input.channel, input.feedUrl);
  const notify = input.announce && shouldNotify(status, input.dismissed, input.explicit);
  window.dispatchEvent(new CustomEvent<UpdateAnnouncement>("ronic-update-status", { detail: { status, notify } }));
  return status;
}

export function onUpdateStatus(handler: (announcement: UpdateAnnouncement) => void) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<UpdateAnnouncement>).detail;
    if (detail?.status) handler(detail);
  };
  window.addEventListener("ronic-update-status", listener);
  return () => window.removeEventListener("ronic-update-status", listener);
}

async function loadUpdateStatus(installed: string, channel: UpdateChannel, feedUrl: string): Promise<UpdateStatus> {
  const address = feedAddress(feedUrl);
  const errors: string[] = [];
  if (address.error) errors.push(address.error);

  const bundled = await readText("/update-feed.json");
  if (bundled.error) errors.push(bundled.error);

  let localText: string | null = null;
  let remoteText: string | null = null;
  if (isTauri()) {
    try {
      const sources = await invokeRaw<FeedSources>("read_update_feed", { feedUrl: address.url });
      if (sources.localError) errors.push(sources.localError);
      if (sources.remoteError) errors.push(sources.remoteError);
      localText = sources.localText;
      remoteText = sources.remoteText;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/read_update_feed|not found|not allowed|unknown command/i.test(message)) errors.push(message);
      if (address.url) {
        const remote = await readText(address.url);
        if (remote.error) errors.push(remote.error);
        remoteText = remote.text;
      }
    }
  } else if (address.url) {
    const remote = await readText(address.url);
    if (remote.error) errors.push("Could not reach the feed address from this preview.");
    remoteText = remote.text;
  }

  const status = pickUpdate(installed, channel, [
    { name: "Feed address", text: remoteText },
    { name: "Local release file", text: localText },
    { name: "This build", text: bundled.text },
  ]);
  return { ...status, errors: [...errors, ...status.errors] };
}

async function readText(url: string): Promise<{ text: string | null; error: string | null }> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return { text: null, error: response.status === 404 ? null : `The release list returned HTTP ${response.status}.` };
    const text = await response.text();
    if (text.length > 65_536) return { text: null, error: "The release list is larger than 64 KB." };
    return { text, error: null };
  } catch {
    return { text: null, error: url.startsWith("/") ? "Could not read the release list in this build." : "Could not reach the feed address." };
  }
}
