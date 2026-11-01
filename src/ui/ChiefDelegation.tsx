import { useState } from "react";
import type { DelegationContract } from "../types";
import { useRonic } from "../store";

function botLabel(id: string, profiles: { id: string; handle: string; displayName: string }[]) {
  const bot = profiles.find((item) => item.id === id);
  if (!bot) return id || "Unknown bot";
  return bot.handle || bot.displayName || bot.id;
}

function providerLabel(id: string, providers: { id: string; name: string }[]) {
  return providers.find((item) => item.id === id)?.name || id || "unassigned";
}

export function ChiefDelegationPanel({ onClose }: { onClose: () => void }) {
  const snap = useRonic((s) => s.snap)!;
  const run = useRonic((s) => s.run);
  const busy = useRonic((s) => s.busy);
  const contracts = snap.delegationContracts ?? [];
  const reports = snap.delegationReports ?? [];
  const [chiefId, setChiefId] = useState(snap.chiefBotId || "");
  const [scope, setScope] = useState("");
  const [objective, setObjective] = useState("");
  const [note, setNote] = useState("");
  const [clarifications, setClarifications] = useState<Record<string, string>>({});
  const [attestNotes, setAttestNotes] = useState<Record<string, string>>({});

  const chief = snap.profiles.find((bot) => bot.id === (snap.chiefBotId || ""));
  const selectedGroup = snap.botGroups.find((group) => group.id === scope);
  const issuerId = selectedGroup ? selectedGroup.leadBotId : snap.chiefBotId || "";
  const canDelegate = objective.trim().length > 0 && issuerId.length > 0 && (selectedGroup ? true : Boolean(snap.chiefBotId));

  async function saveChief() {
    const res = await run("appoint_chief_officer", { botId: chiefId });
    setNote(res?.toast || useRonic.getState().toast || "Could not save the chief officer.");
  }

  async function delegate() {
    const res = await run("dispatch_delegation", { issuerBotId: issuerId, groupId: scope, objective: objective.trim() });
    setNote(res?.toast || useRonic.getState().toast || "Could not delegate.");
    if (res?.toast && !res.toast.startsWith("Delegated")) return;
    if (res) setObjective("");
  }

  async function resolve(contract: DelegationContract) {
    const clarification = (clarifications[contract.id] || "").trim();
    const res = await run("resolve_delegation_friction", { contractId: contract.id, note: clarification });
    setNote(res?.toast || useRonic.getState().toast || "Could not save that clarification.");
  }

  async function attest(contract: DelegationContract) {
    const attestation = (attestNotes[contract.id] || "").trim();
    const res = await run("attest_delegation_contract", { contractId: contract.id, note: attestation });
    setNote(res?.toast || useRonic.getState().toast || "Could not attest that contract.");
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Chief officer">
        <div className="pane-h">
          Chief officer
          <button type="button" className="btn ghost small" onClick={onClose}>Close</button>
        </div>
        <div className="pane-b stack">
          <p className="muted">Pick one of your bots as chief. That bot can split an objective across the others. A group lead can assign work only inside that group. A contract stays in progress until you attest it.</p>
          <label className="field">
            <span>Chief officer</span>
            <select className="select" value={chiefId} onChange={(event) => setChiefId(event.target.value)}>
              <option value="">No chief</option>
              {snap.profiles.map((bot) => (
                <option key={bot.id} value={bot.id}>{botLabel(bot.id, snap.profiles)}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" disabled={busy || chiefId === (snap.chiefBotId || "")} onClick={() => void saveChief()}>
            {chiefId ? "Save chief" : "Clear chief"}
          </button>
          <p className="muted">{chief ? `${botLabel(chief.id, snap.profiles)} is the chief.` : "No chief is appointed."}</p>

          <label className="field">
            <span>Who assigns the work</span>
            <select className="select" value={scope} onChange={(event) => setScope(event.target.value)}>
              <option value="">Workspace — the chief</option>
              {snap.botGroups.map((group) => (
                <option key={group.id} value={group.id}>{group.title || group.groupHandle} — {botLabel(group.leadBotId, snap.profiles)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Objective</span>
            <textarea className="area" rows={3} value={objective} placeholder="What should be finished" onChange={(event) => setObjective(event.target.value)} />
          </label>
          <button type="button" className="btn" disabled={busy || !canDelegate} onClick={() => void delegate()}>Decompose and delegate</button>
          <p className="muted">Separate jobs with “and”, a semicolon, or a new line. A short note, a two-way choice, two currencies without a rate, or a payment request pauses for you. Phone messages that start with /chief, #group, or @manager are delegated only when that channel is connected to its allowlisted owner.</p>
          {note ? <p className="muted" role="status">{note}</p> : null}

          {contracts.length === 0 ? <p className="muted">No contracts yet.</p> : null}
          {contracts.map((contract) => {
            const related = reports.filter((report) => report.contractId === contract.id).slice(0, 2);
            return (
              <section key={contract.id} className="stack" style={{ borderTop: "1px solid var(--line, #e4e4e7)", paddingTop: 12 }}>
                <strong>{contract.subGoal}</strong>
                <span className="mono">{botLabel(contract.issuerBotId, snap.profiles)} → {botLabel(contract.assigneeBotId, snap.profiles)}</span>
                <span className="muted">{contract.scopeLabel} · {contract.status.replaceAll("_", " ")} · {contract.costTier} via {providerLabel(contract.routedEndpoint, snap.providers)} · complexity {contract.complexityScore}</span>
                <span className="muted">{contract.verifierRule}</span>
                <span className="muted">Permissions: {contract.scopes.join(", ")}</span>
                <span className="mono" title={contract.commitment}>{contract.commitment}</span>
                {contract.frictionReason ? <p className="muted" role="status">{contract.frictionReason}</p> : null}
                {related.map((report) => <p key={report.id} className="muted">{report.reportType.replaceAll("_", " ")}: {report.summary}</p>)}
                {contract.status === "friction_challenged" ? (
                  <div className="stack">
                    <input className="input" value={clarifications[contract.id] || ""} placeholder="Name the one action to take" onChange={(event) => setClarifications((prev) => ({ ...prev, [contract.id]: event.target.value }))} />
                    <button type="button" className="btn small" disabled={busy} onClick={() => void resolve(contract)}>Save clarification</button>
                  </div>
                ) : null}
                {contract.status === "in_progress" ? (
                  <div className="stack">
                    <input className="input" value={attestNotes[contract.id] || ""} placeholder="What you checked before marking this done" onChange={(event) => setAttestNotes((prev) => ({ ...prev, [contract.id]: event.target.value }))} />
                    <button type="button" className="btn small" disabled={busy} onClick={() => void attest(contract)}>Attest done</button>
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
