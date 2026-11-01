import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useRonic } from "../store";
import { onUpdateStatus, runUpdateCheck } from "../updates/check";
import { dismissNotice, normalizeUpdateSettings, PRODUCT_VERSION, readDismissedNotice, type ProductRelease } from "../updates/feed";

export function UpdateNotice() {
  const snap = useRonic((s) => s.snap);
  const go = useRonic((s) => s.go);
  const [release, setRelease] = useState<ProductRelease | null>(null);
  const [newer, setNewer] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    return onUpdateStatus((announcement) => {
      if (!announcement.notify) return;
      const next = announcement.status.available ?? announcement.status.current;
      if (!next) return;
      setNewer(Boolean(announcement.status.available));
      setRelease(next);
    });
  }, []);

  useEffect(() => {
    if (!snap?.onboardingComplete || !snap.vaultUnlocked) return;
    if (started.current) return;
    started.current = true;
    const settings = normalizeUpdateSettings(snap.settings);
    if (settings.updateMode !== "auto") return;
    void runUpdateCheck({
      installed: PRODUCT_VERSION,
      channel: settings.updateChannel,
      feedUrl: settings.updateFeedUrl,
      announce: true,
      explicit: false,
      dismissed: dismissedVersions(settings.updateNoticeVersion),
    });
  }, [snap]);

  if (!release) return null;

  function close(remember: boolean) {
    if (remember && release) dismissNotice(release.version);
    setRelease(null);
  }

  function view() {
    if (release) dismissNotice(release.version);
    sessionStorage.setItem("ronic.settings.section", "update");
    go("settings");
    window.dispatchEvent(new Event("ronic-open-update"));
    setRelease(null);
  }

  return (
    <aside className="update-notice" role="status" aria-live="polite" aria-label={newer ? "Update available" : "What's new"}>
      <div className="update-notice-head">
        <h2>{newer ? "Update available" : "What's new"}</h2>
        <button type="button" className="btn ghost small" aria-label="Dismiss update notice" onClick={() => close(true)}>
          <X size={14} />
        </button>
      </div>
      <p className="mono">Ronic OS {release.version}</p>
      <p>{release.summary || release.changes[0]?.title || "A release is ready to view."}</p>
      <div className="row-actions">
        <button type="button" className="btn small" onClick={view}>View changes</button>
        <button type="button" className="btn ghost small" onClick={() => close(true)}>Later</button>
      </div>
    </aside>
  );
}

function dismissedVersions(saved: string) {
  return [readDismissedNotice(), saved].filter(Boolean);
}
