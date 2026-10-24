import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Play } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../api";
import { useOmni } from "../store";
import type { WfNode, Workflow } from "../types";

const STEP_KINDS = [
  { id: "llm_reasoning", label: "Bot reasoning" },
  { id: "bot_action", label: "Bot action" },
  { id: "browser_inspect", label: "Browser inspect" },
  { id: "code_patch", label: "Code patch" },
  { id: "wallet_execution", label: "Wallet gate" },
  { id: "approval_gate", label: "Approval gate" },
] as const;

export default function WorkflowsStudio() {
  const run = useOmni((s) => s.run);
  const snap = useOmni((s) => s.snap);
  const go = useOmni((s) => s.go);
  const busy = useOmni((s) => s.busy);

  const workflows = snap?.workflows ?? [];
  const [activeWfId, setActiveWfId] = useState<string>(workflows[0]?.id ?? "");
  const [selectedNodeId, setSelectedNodeId] = useState<string>(workflows[0]?.nodes[0]?.id ?? "");
  const [newWfName, setNewWfName] = useState<string>("");
  const [live, setLive] = useState<{ wfId: string; status: string; nodes: WfNode[] } | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const unlistenPromise = listen<{ id: string; status: string; nodes: WfNode[] }>("omni://wf-progress", (event) => {
      const payload = event.payload;
      if (payload?.id) {
        setLive({ wfId: payload.id, status: payload.status, nodes: payload.nodes ?? [] });
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!workflows.some((w) => w.id === activeWfId) && workflows[0]) {
      setActiveWfId(workflows[0].id);
      setSelectedNodeId(workflows[0].nodes[0]?.id ?? "");
    }
  }, [workflows, activeWfId]);

  const snapshotWf = workflows.find((w) => w.id === activeWfId) ?? workflows[0] ?? null;
  const liveForThis = live && live.wfId === snapshotWf?.id ? live : null;
  const activeWf: Workflow | null = liveForThis
    ? { ...snapshotWf!, nodes: liveForThis.nodes, currentStatus: liveForThis.status }
    : snapshotWf;
  const selectedNode = activeWf?.nodes.find((n) => n.id === selectedNodeId) ?? activeWf?.nodes[0] ?? null;

  const yaml = useMemo(() => (activeWf ? activeWf.yamlSource || emitYaml(activeWf, activeWf.nodes) : ""), [activeWf]);

  const handleCreateWorkflow = () => {
    if (!newWfName.trim()) return;
    void run("create_workflow", { name: newWfName.trim() }).then((res) => {
      const created = res?.snapshot.workflows.find((w) => w.name === newWfName.trim());
      if (created) {
        setActiveWfId(created.id);
        setSelectedNodeId(created.nodes[0]?.id ?? "");
      }
      setNewWfName("");
    });
  };

  const persist = (wf: Workflow, nodes: WfNode[]) => {
    void run("update_workflow", { patch: { id: wf.id, yamlSource: emitYaml(wf, nodes) } });
  };

  const handleAddNode = (kind: string) => {
    if (!snapshotWf) return;
    const id = `node_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
    const node: WfNode = {
      id,
      name: `${(liveForThis?.nodes.length ?? snapshotWf.nodes.length) + 1}. ${kind.replace(/_/g, " ")}`,
      kind,
      botProfile: "",
      model: "",
      prompt: "",
      status: "pending",
      latencyMs: 0,
    };
    setSelectedNodeId(id);
    setLive(null);
    persist(snapshotWf, [...(liveForThis?.nodes ?? snapshotWf.nodes), node]);
  };

  const handleUpdateNode = (patch: Partial<WfNode>) => {
    if (!snapshotWf || !selectedNode) return;
    const base = liveForThis?.nodes ?? snapshotWf.nodes;
    persist(
      snapshotWf,
      base.map((n) => (n.id === selectedNode.id ? { ...n, ...patch } : n))
    );
  };

  const handleDeleteNode = () => {
    if (!snapshotWf || !selectedNode) return;
    const base = liveForThis?.nodes ?? snapshotWf.nodes;
    if (base.length < 2) return;
    const remaining = base.filter((n) => n.id !== selectedNode.id);
    setSelectedNodeId(remaining[0].id);
    setLive(null);
    persist(snapshotWf, remaining);
  };

  return (
    <div className="flex-1 h-full bg-[#FAFAFA] text-[#0F172A] p-6 overflow-y-auto space-y-4 font-sans select-none">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => go("chat")}
            className="px-2.5 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] text-[#0F172A] hover:border-[#111111] rounded-[6px] flex items-center gap-1.5 transition cursor-pointer shadow-xs"
            title="Back to Chat (Alt+Left)"
            aria-label="Back to Chat"
          >
            <ArrowLeft size={13} />
            <span>Back</span>
          </button>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight">{activeWf?.name ?? "Workflows"}</h1>
              {activeWf ? (
                <span className={`px-2.5 py-0.5 text-xs font-mono font-semibold rounded-full border ${statusTone(activeWf.currentStatus)}`}>
                  {activeWf.currentStatus}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-[#64748B] mt-0.5">
              Run executes every pending step through its assigned bot — real replies, real latency, results on the step and in the chat. Approval and wallet steps pause the run; Resume approves the paused gate and continues.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={newWfName}
            onChange={(e) => setNewWfName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateWorkflow();
            }}
            placeholder="New workflow name..."
            className="px-3 py-1.5 text-xs bg-white border border-[#E5E5E5] rounded-[6px] outline-none focus:border-[#111111]"
          />
          <button onClick={handleCreateWorkflow} className="px-3 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] rounded-[6px] hover:border-[#111111] cursor-pointer">
            Create
          </button>
          <button
            onClick={() => {
              setLive(null);
              if (snapshotWf) void run("run_workflow", { id: snapshotWf.id });
            }}
            disabled={!snapshotWf || busy}
            className="px-3.5 py-1.5 text-xs font-semibold bg-[#111111] text-white rounded-[6px] hover:opacity-90 cursor-pointer disabled:opacity-50 flex items-center gap-1.5"
          >
            <Play size={12} className="fill-current" />
            Run workflow
          </button>
          <button
            onClick={() => snapshotWf && void run("pause_workflow", { id: snapshotWf.id, nodeId: selectedNode?.id })}
            disabled={!snapshotWf || busy}
            className="px-3 py-1.5 text-xs font-semibold bg-white border border-[#E5E5E5] rounded-[6px] hover:border-[#111111] cursor-pointer disabled:opacity-50"
          >
            Pause here
          </button>
          <button
            onClick={() => {
              setLive(null);
              if (snapshotWf) void run("resume_workflow", { id: snapshotWf.id });
            }}
            disabled={!snapshotWf || busy}
            className="px-3.5 py-1.5 text-xs font-semibold bg-[#111111] text-white rounded-[6px] hover:opacity-90 cursor-pointer disabled:opacity-50"
          >
            Resume from checkpoint
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 bg-white border border-[#E5E5E5] p-2.5 rounded-[6px]">
        <div className="flex flex-wrap items-center gap-1.5">
          {workflows.length === 0 ? <span className="text-xs text-[#64748B] px-2">No workflows yet. Create one to write a YAML file.</span> : null}
          {workflows.map((wf) => (
            <button
              key={wf.id}
              onClick={() => {
                setActiveWfId(wf.id);
                if (wf.nodes[0]) setSelectedNodeId(wf.nodes[0].id);
              }}
              className={`px-3 py-1 text-xs font-semibold rounded-[6px] transition cursor-pointer ${
                wf.id === activeWf?.id ? "bg-[#111111] text-white" : "bg-[#F8FAFC] text-[#64748B] hover:text-[#0F172A] border border-transparent hover:border-[#E5E5E5]"
              }`}
            >
              {wf.name}
            </button>
          ))}
        </div>
        {activeWf ? (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] font-mono text-[#64748B] mr-1">Add step:</span>
            {STEP_KINDS.map((kind) => (
              <button
                key={kind.id}
                onClick={() => handleAddNode(kind.id)}
                className="px-2.5 py-1 text-xs font-semibold border border-[#E5E5E5] rounded hover:border-[#111111] cursor-pointer"
              >
                + {kind.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div
          className="lg:col-span-8 bg-white border border-[#E5E5E5] rounded-[6px] p-6 min-h-[500px] flex flex-col items-center justify-center space-y-3"
          style={{ backgroundImage: "radial-gradient(#CBD5E1 1px, transparent 1px)", backgroundSize: "18px 18px" }}
        >
          {!activeWf ? (
            <p className="text-sm text-[#64748B]">Create a workflow to see its nodes.</p>
          ) : (
            activeWf.nodes.map((node, index) => {
              const isSelected = node.id === selectedNode?.id;
              return (
                <React.Fragment key={node.id}>
                  <div
                    onClick={() => setSelectedNodeId(node.id)}
                    className={`w-full max-w-md bg-white rounded-[6px] p-4 cursor-pointer transition shadow-xs border ${
                      isSelected ? "border-2 border-[#111111]" : "border-[#E5E5E5] hover:border-[#94A3B8]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-bold text-[#0F172A]">{node.name}</span>
                      <span className={`px-2 py-0.5 text-[11px] font-mono font-semibold rounded-full ${nodeStatusTone(node.status)}`}>
                        {node.status}
                        {node.latencyMs ? ` • ${node.latencyMs}ms` : ""}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-1.5 text-xs font-mono text-[#64748B]">
                      <span>{node.kind}</span>
                      <span className="text-[#0F172A] font-semibold">{node.botProfile || node.model || "unassigned"}</span>
                    </div>
                    <p className="text-xs text-[#64748B] mt-2 line-clamp-2">{node.prompt || "No prompt yet."}</p>
                  </div>
                  {index < activeWf.nodes.length - 1 && (
                    <div className="flex flex-col items-center text-[#64748B] font-mono text-xs">
                      <div className="h-4 w-[1.5px] bg-[#CBD5E1]" />
                      <span>▼</span>
                    </div>
                  )}
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="lg:col-span-4 bg-white border border-[#E5E5E5] rounded-[6px] p-4 space-y-3 text-xs">
          <div className="flex items-center justify-between border-b border-[#E5E5E5] pb-2.5">
            <h2 className="text-sm font-bold text-[#0F172A]">Step inspector {selectedNode ? `(${selectedNode.id})` : ""}</h2>
            {activeWf && selectedNode && activeWf.nodes.length > 1 ? (
              <button onClick={handleDeleteNode} className="text-rose-600 font-semibold hover:underline cursor-pointer">
                Delete step
              </button>
            ) : null}
          </div>
          {!selectedNode ? (
            <p className="text-[#64748B]">Select a step to edit it. Changes write through update_workflow when you leave a field.</p>
          ) : (
            <>
              <NodeEditor key={selectedNode.id} node={selectedNode} onCommit={handleUpdateNode} />
              <div className="pt-2 border-t border-[#E5E5E5]">
                <div className="font-semibold text-[#64748B] mb-1">Step output</div>
                <pre className="p-2.5 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] font-mono text-[10.5px] max-h-40 overflow-y-auto whitespace-pre-wrap text-[#334155]">
                  {snapshotWf?.checkpoint?.[selectedNode.id] || "This step has not run yet."}
                </pre>
              </div>
              <div className="pt-2 border-t border-[#E5E5E5]">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold text-[#64748B]">YAML on disk</span>
                </div>
                <pre className="p-2.5 bg-[#F8FAFC] border border-[#E5E5E5] rounded-[6px] font-mono text-[10.5px] max-h-48 overflow-y-auto whitespace-pre-wrap text-[#334155]">
                  {yaml}
                </pre>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NodeEditor({ node, onCommit }: { node: WfNode; onCommit: (patch: Partial<WfNode>) => void }) {
  const [draft, setDraft] = useState(node);
  useEffect(() => {
    setDraft(node);
  }, [node.id]);
  const commit = (patch: Partial<WfNode>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onCommit(patch);
  };
  return (
    <div className="space-y-2.5">
      <label className="font-semibold text-[#64748B] block">
        Step title
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          onBlur={() => commit({ name: draft.name })}
          className="w-full mt-1 px-2.5 py-1.5 border border-[#E5E5E5] rounded-[6px] bg-white text-[#0F172A]"
        />
      </label>
      <label className="font-semibold text-[#64748B] block">
        Step type
        <select
          value={draft.kind}
          onChange={(e) => commit({ kind: e.target.value })}
          className="w-full mt-1 px-2.5 py-1.5 border border-[#E5E5E5] rounded-[6px] bg-white font-mono text-[#0F172A]"
        >
          {STEP_KINDS.map((kind) => (
            <option key={kind.id} value={kind.id}>
              {kind.id}
            </option>
          ))}
          {!STEP_KINDS.some((k) => k.id === draft.kind) ? <option value={draft.kind}>{draft.kind}</option> : null}
        </select>
      </label>
      <label className="font-semibold text-[#64748B] block">
        Assigned bot
        <input
          value={draft.botProfile}
          onChange={(e) => setDraft({ ...draft, botProfile: e.target.value })}
          onBlur={() => commit({ botProfile: draft.botProfile })}
          className="w-full mt-1 px-2.5 py-1.5 border border-[#E5E5E5] rounded-[6px] font-mono bg-white text-[#0F172A]"
        />
      </label>
      <label className="font-semibold text-[#64748B] block">
        Model
        <input
          value={draft.model}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          onBlur={() => commit({ model: draft.model })}
          className="w-full mt-1 px-2.5 py-1.5 border border-[#E5E5E5] rounded-[6px] font-mono bg-white text-[#0F172A]"
        />
      </label>
      <label className="font-semibold text-[#64748B] block">
        Step prompt
        <textarea
          rows={3}
          value={draft.prompt}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          onBlur={() => commit({ prompt: draft.prompt })}
          className="w-full mt-1 p-2 border border-[#E5E5E5] rounded-[6px] bg-white text-[#0F172A]"
        />
      </label>
    </div>
  );
}

function statusTone(status: string) {
  if (status === "completed" || status === "done") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "error") return "bg-rose-50 text-rose-700 border-rose-200";
  if (status === "running") return "bg-blue-50 text-blue-700 border-blue-200";
  if (status.includes("paused")) return "bg-amber-50 text-amber-800 border-amber-300";
  return "bg-slate-100 text-[#64748B] border-[#E5E5E5]";
}

function nodeStatusTone(status: string) {
  if (status === "completed" || status === "done") return "bg-emerald-50 text-emerald-700 border border-emerald-200";
  if (status === "error") return "bg-rose-50 text-rose-700 border border-rose-200";
  if (status === "running") return "bg-blue-50 text-blue-700 border border-blue-200 animate-pulse";
  if (status === "paused") return "bg-amber-50 text-amber-800 border border-amber-300";
  return "bg-slate-100 text-[#64748B]";
}

function yamlStr(s: string) {
  if (!s || /[:#"'\n]/.test(s) || s.startsWith(" ")) return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
  return s;
}

function emitYaml(wf: Workflow, nodes: WfNode[]) {
  const paused = wf.pausedAtNodeId ? `paused_at: ${yamlStr(wf.pausedAtNodeId)}\n` : "";
  const triggers = (wf.triggers ?? []).map((t) => `  - ${yamlStr(t)}`).join("\n");
  const nodeBlock = nodes
    .map(
      (n) => `  - id: ${yamlStr(n.id)}
    name: ${yamlStr(n.name)}
    kind: ${yamlStr(n.kind)}
    bot: ${yamlStr(n.botProfile)}
    model: ${yamlStr(n.model)}
    status: ${yamlStr(n.status)}
    latency_ms: ${n.latencyMs}
    prompt: ${yamlStr(n.prompt)}`
    )
    .join("\n");
  return `id: ${yamlStr(wf.id)}
name: ${yamlStr(wf.name)}
status: ${yamlStr(wf.currentStatus)}
${paused}triggers:
${triggers ? `${triggers}\n` : ""}nodes:
${nodeBlock}
`;
}
