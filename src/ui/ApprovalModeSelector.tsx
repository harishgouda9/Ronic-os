import { useState } from "react";
import { BotProfile } from "../types";
import { useRonic } from "../store";

type ApprovalMode = "auto" | "ask" | "manual";

const MODES: { value: ApprovalMode; label: string; description: string }[] = [
  {
    value: "auto",
    label: "Auto Approve",
    description: "Bot researches, plans, and executes autonomously. Only asks for critical decisions.",
  },
  {
    value: "ask",
    label: "Ask",
    description: "Bot asks for approval before external actions and wallet spend.",
  },
  {
    value: "manual",
    label: "Manual",
    description: "Bot holds every action for explicit approval. Maximum control.",
  },
];

export function ApprovalModeSelector({
  profile,
  onUpdate,
}: {
  profile: BotProfile;
  onUpdate?: (updated: BotProfile) => void;
}) {
  const run = useRonic((s) => s.run);
  const [saving, setSaving] = useState(false);

  const currentMode = (profile.approvalMode as ApprovalMode) || "ask";

  async function selectMode(mode: ApprovalMode) {
    if (mode === currentMode || saving) return;

    setSaving(true);
    const updated: BotProfile = {
      ...profile,
      approvalMode: mode,
      requireApprovalExternal: mode !== "auto",
      requireApprovalWallet: mode !== "auto",
    };

    await run("save_profile", { profile: updated });
    onUpdate?.(updated);
    setSaving(false);
  }

  return (
    <div className="approval-mode-selector">
      <label className="approval-mode-label">Approval Mode</label>
      <div className="approval-mode-options">
        {MODES.map((mode) => (
          <button
            key={mode.value}
            className={`approval-mode-option ${currentMode === mode.value ? "active" : ""}`}
            onClick={() => selectMode(mode.value)}
            disabled={saving}
            title={mode.description}
          >
            <span className="approval-mode-name">{mode.label}</span>
            <span className="approval-mode-desc">{mode.description}</span>
          </button>
        ))}
      </div>
      {saving && <span className="approval-mode-saving">Saving...</span>}
    </div>
  );
}
