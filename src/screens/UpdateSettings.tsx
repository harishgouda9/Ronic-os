import { useEffect, useState } from "react";
import { invokeRaw, isTauri } from "../api";
import type { Settings } from "../types";
import { runUpdateCheck } from "../updates/check";
import {
  compareVersions,
  normalizeUpdateSettings,
  PRODUCT_VERSION,
  readDismissedNotice,
  type ProductRelease,
  type UpdateStatus,
} from "../updates/feed";
import { Pill } from "../ui/bits";

export function UpdateSettings({
  draft,
  set,
  homeDir,
}: {
  draft: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  homeDir: string;
}) {
  const settings = normalizeUpdateSettings(draft);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [note, setNote] = useState("");

  async function check(explicit: boolean) {
    setChecking(true);
    setNote("");
    const next = normalizeUpdateSettings({ ...draft, updateMode: settings.updateMode, updateChannel: settings.updateChannel, updateFeedUrl: settings.updateFeedUrl });
    const result = await runUpdateCheck({
      installed: PRODUCT_VERSION,
      channel: next.updateChannel,
      feedUrl: next.updateFeedUrl,
      announce: explicit,
      explicit,
      dismissed: [readDismissedNotice(), next.updateNoticeVersion].filter(Boolean),
    });
    setStatus(result);
    setChecking(false);
  }

  useEffect(() => {
    void check(false);
    // The panel mounts when Update is opened. Channel and feed edits wait for Check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const downloadUrl = status?.available?.downloadUrl || status?.current?.downloadUrl || "";
  const listed = status?.history ?? [];

  async function openDownload() {
    if (!downloadUrl) return;
    if (!isTauri()) {
      window.open(downloadUrl, "_blank", "noopener,noreferrer");
      return;
    }
    try {
      await invokeRaw("open_system_url", { url: downloadUrl });
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="stack" aria-label="Release notes">
      <h2 className="h2">Update</h2>
      <p className="muted">
        Auto update checks when Ronic OS opens and shows a small notice. Manual update checks when you press the button.
        A check reads the release notes. It does not download or replace this app. When a release includes an https address, Open download hands it to the browser.
      </p>
      <div className="grid-2">
        <article className="card">
          <div className="muted">Installed</div>
          <div className="kpi">{PRODUCT_VERSION}</div>
          <div className="faint">This build</div>
        </article>
        <article className="card">
          <div className="muted">Release</div>
          <div>{statusLine(status, checking, settings.updateChannel)}</div>
        </article>
      </div>
      <div className="grid-2">
        <label className="field">
          <span>How updates run</span>
          <select className="select" value={settings.updateMode} onChange={(event) => set("updateMode", event.target.value === "manual" ? "manual" : "auto")}>
            <option value="auto">Auto update</option>
            <option value="manual">Manual update</option>
          </select>
        </label>
        <label className="field">
          <span>Update channel</span>
          <select className="select" value={settings.updateChannel} onChange={(event) => set("updateChannel", event.target.value === "nightly" ? "nightly" : "stable")}>
            <option value="stable">Stable</option>
            <option value="nightly">Nightly</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span>Feed address</span>
        <input
          className="input"
          value={settings.updateFeedUrl}
          onChange={(event) => set("updateFeedUrl", event.target.value)}
          placeholder="https://… optional"
          spellCheck={false}
        />
      </label>
      <p className="faint">Save changes keeps the mode, channel, and feed address. Leave the address blank to use the release file shipped with this build{homeDir ? ` and ${feedFile(homeDir)}` : ""}.</p>
      <div className="row-actions">
        <button type="button" className="btn" disabled={checking} onClick={() => void check(true)}>{checking ? "Checking…" : "Check for updates"}</button>
        {downloadUrl ? <button type="button" className="btn ghost" onClick={() => void openDownload()}>Open download</button> : null}
      </div>
      {note ? <p className="muted">{note}</p> : null}
      {status?.errors.map((error) => <p key={error} className="faint">{error}</p>)}
      {listed.length === 0 && !checking ? <p className="muted">No change list is published for the {settings.updateChannel} channel.</p> : null}
      {listed.map((release) => (
        <ReleaseCard key={`${release.source}-${release.version}`} release={release} installed={PRODUCT_VERSION} />
      ))}
      <details className="update-publish">
        <summary>Publish a release</summary>
        <p className="muted">
          Raise version above {PRODUCT_VERSION}. This build reads public/update-feed.json. The desktop app also reads {feedFile(homeDir)} after the next desktop build, and the https address above when one is saved.
          Auto update shows the notice the next time Ronic OS opens. Manual update shows it after Check for updates.
        </p>
        <pre className="mono">{`{
  "version": "2.2.0",
  "channel": "stable",
  "published": "2026-11-01",
  "summary": "What this release is for",
  "downloadUrl": "https://example.com/RonicOS-setup.exe",
  "changes": [
    { "kind": "feature", "title": "Name", "detail": "What changed" }
  ]
}`}</pre>
      </details>
    </div>
  );
}

function ReleaseCard({ release, installed }: { release: ProductRelease; installed: string }) {
  const newer = compareVersions(release.version, installed) > 0;
  const current = compareVersions(release.version, installed) === 0;
  return (
    <article className="card stack">
      <div className="between">
        <strong>Ronic OS {release.version}</strong>
        <span className="row-actions">
          {newer ? <Pill kind="ok">Available</Pill> : null}
          {current ? <Pill>Installed</Pill> : null}
          <Pill>{release.channel === "any" ? "stable and nightly" : release.channel}</Pill>
        </span>
      </div>
      <div className="faint">{[release.published, release.source].filter(Boolean).join(" · ")}</div>
      {release.summary ? <p className="muted">{release.summary}</p> : null}
      {release.changes.length === 0 ? <p className="faint">No change list was published for this release.</p> : null}
      {release.changes.map((change, index) => (
        <div key={`${change.kind}-${index}`} className="update-change">
          <div className="between">
            <strong>{change.title}</strong>
            <Pill kind={change.kind === "feature" ? "ok" : change.kind === "fix" ? "warn" : ""}>{change.kind}</Pill>
          </div>
          {change.detail ? <p className="muted">{change.detail}</p> : null}
        </div>
      ))}
    </article>
  );
}

function statusLine(status: UpdateStatus | null, checking: boolean, channel: string) {
  if (checking && !status) return "Reading the release list…";
  if (!status) return "Press Check for updates.";
  if (status.available) return `${status.available.version} is available on the ${channel} channel.`;
  if (status.current) return `${status.installed} is the newest release on the ${channel} channel.`;
  if (checking) return "Checking for a release…";
  return `No release is listed for the ${channel} channel.`;
}

function feedFile(homeDir: string) {
  if (!homeDir) return "update-feed.json";
  const sep = homeDir.includes("\\") ? "\\" : "/";
  return `${homeDir.replace(/[\\/]+$/, "")}${sep}update-feed.json`;
}
