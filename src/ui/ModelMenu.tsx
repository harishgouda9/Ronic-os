import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatModel, ChatProviderLink, Effort } from "../kernel/liveChat";
import { GROUP_ORDER, groupsFor } from "../kernel/modelPrefs";
import { ProviderAuth, ProviderState } from "./ProviderAuth";

function rank(group: string) {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

const EFFORTS: { id: Effort; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
  { id: "xhigh", label: "XHigh" },
];

export function ModelMenu({
  open,
  models,
  selectedId,
  effortOf,
  stars,
  status,
  mode,
  refreshing,
  providers,
  links,
  onClose,
  onSelect,
  onEffort,
  onStar,
  onRefresh,
  onMode,
  onCreate,
  onSaveEdit,
  onHide,
  onSignIn,
  onOpenKeys,
  onContinueChatGpt,
  onSaveKey,
  focusGroup,
  focusTick,
}: {
  open: boolean;
  models: ChatModel[];
  selectedId: string;
  effortOf: (id: string) => Effort;
  stars: string[];
  status: string;
  mode: "list" | "add" | "edit";
  refreshing: boolean;
  providers: { id: string; name: string }[];
  links: ChatProviderLink[];
  onClose: () => void;
  onSelect: (id: string) => void;
  onEffort: (id: string, effort: Effort) => void;
  onStar: (id: string) => void;
  onRefresh: () => void;
  onMode: (mode: "list" | "add" | "edit") => void;
  onCreate: (draft: { label: string; upstreamModel: string; providerId: string }) => void;
  onSaveEdit: (id: string, patch: { label: string; upstreamModel: string }) => void;
  onHide: (id: string) => void;
  onSignIn: (siteId: string) => void;
  onOpenKeys: (url: string) => void;
  onContinueChatGpt: () => void;
  onSaveKey: (id: string, secret: string) => void;
  focusGroup: string;
  focusTick: number;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [effortForId, setEffortForId] = useState<string | null>(null);
  const [manageGroup, setManageGroup] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupsFor(models, query), [models, query]);
  const sections = useMemo(() => {
    const byTitle = new Map(groups.map((group) => [group.title, group.models]));
    const ranked = [...links].sort((a, b) => rank(a.group) - rank(b.group));
    const seen = new Set<string>();
    const rows: { title: string; link?: ChatProviderLink; models: ChatModel[] }[] = [];
    for (const link of ranked) {
      if (seen.has(link.group)) continue;
      seen.add(link.group);
      rows.push({ title: link.group, link, models: byTitle.get(link.group) ?? [] });
    }
    for (const group of groups) {
      if (seen.has(group.title)) continue;
      rows.push({ title: group.title, models: group.models });
    }
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.title.toLowerCase().includes(needle) || row.models.length > 0);
  }, [groups, links, query]);

  useEffect(() => {
    if (!focusGroup) return;
    setCollapsed((prev) => ({ ...prev, [focusGroup]: false }));
  }, [focusGroup, focusTick]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-model-trigger]")) return;
      if (!root.current?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="model-pop" ref={root}>
      <input
        className="input"
        placeholder="Search models"
        value={query}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.preventDefault();
        }}
      />
      <div className="model-scroll">
        {mode === "add" ? (
          providers.length === 0
            ? <p className="muted">Add an API key on a provider card, or start Ollama, before adding a model.</p>
            : <CustomForm providers={providers} onCreate={onCreate} onCancel={() => onMode("list")} />
        ) : null}
        {mode === "edit" ? (
          models.length === 0
            ? <p className="muted">No connected models to edit.</p>
            : <EditList models={models} onSave={onSaveEdit} onHide={onHide} />
        ) : null}
        {mode === "list" ? sections.map((section) => {
          const shut = !query && (collapsed[section.title] ?? true);
          return (
            <section key={section.title}>
              <button
                type="button"
                className="model-group"
                onClick={() => setCollapsed((prev) => ({ ...prev, [section.title]: !(prev[section.title] ?? true) }))}
              >
                <span className="provider-name">{section.title}</span>
                {section.link ? <ProviderState link={section.link} /> : null}
                <span>{shut ? "▸" : "▾"}</span>
              </button>
              {shut ? null : section.models.map((model) => {
                const effort = effortOf(model.id);
                return (
                  <div key={model.id} className={`model-row ${model.id === selectedId ? "on" : ""}`}>
                    <button type="button" className={`star ${stars.includes(model.id) ? "on" : ""}`} title="Star" onClick={() => onStar(model.id)}>{stars.includes(model.id) ? "★" : "☆"}</button>
                    <button type="button" className="model-name" onClick={() => onSelect(model.id)}>{model.label}</button>
                    {effort !== "default" ? <span className="effort-pill">{effort === "xhigh" ? "XHIGH" : effort.toUpperCase()}</span> : null}
                    <button type="button" className="chev" title="Effort" onClick={() => setEffortForId((current) => current === model.id ? null : model.id)}>›</button>
                    {effortForId === model.id ? (
                      <div className="effort-menu">
                        {EFFORTS.map((item) => (
                          <button key={item.id} type="button" className={item.id === effort ? "on" : ""} onClick={() => { onEffort(model.id, item.id); setEffortForId(null); }}>
                            {item.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {!shut && section.link && (section.models.length === 0 || !section.link.ready || manageGroup === section.title) ? (
                <ProviderAuth link={section.link} onSignIn={onSignIn} onOpenKeys={onOpenKeys} onContinueChatGpt={onContinueChatGpt} onSaveKey={onSaveKey} />
              ) : null}
              {!shut && section.link && section.link.ready && !section.link.local && section.models.length > 0 && manageGroup !== section.title ? (
                <div className="provider-auth">
                  <p className="muted">Connected. Its models are listed above.</p>
                  <div className="row-actions">
                    <button type="button" className="btn ghost small" onClick={() => setManageGroup(section.title)}>Replace key</button>
                  </div>
                </div>
              ) : null}
            </section>
          );
        }) : null}
        {mode === "list" && sections.length === 0 ? <p className="muted">{query ? "No model matches that search." : "No providers yet. Refresh checks again."}</p> : null}
      </div>
      {status ? <p className="model-status">{status}</p> : null}
      <div className="model-foot">
        <button type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? "Refreshing…" : "↻ Refresh models"}</button>
        <button type="button" onClick={() => onMode(mode === "add" ? "list" : "add")}>+ Add custom model...</button>
        <button type="button" onClick={() => onMode(mode === "edit" ? "list" : "edit")}>✎ Edit models...</button>
      </div>
    </div>
  );
}

function CustomForm({ providers, onCreate, onCancel }: { providers: { id: string; name: string }[]; onCreate: (draft: { label: string; upstreamModel: string; providerId: string }) => void; onCancel: () => void }) {
  const [label, setLabel] = useState("");
  const [upstreamModel, setUpstream] = useState("");
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "prov_openrouter");
  return (
    <div className="model-form">
      <label className="field"><span>Name</span><input className="input" value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label className="field"><span>Model id</span><input className="input" value={upstreamModel} placeholder="the provider's model id" onChange={(event) => setUpstream(event.target.value)} /></label>
      <label className="field">
        <span>Provider</span>
        <select className="select" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
          {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select>
      </label>
      <div className="row-actions">
        <button type="button" className="btn small" disabled={!label.trim() || !upstreamModel.trim()} onClick={() => onCreate({ label, upstreamModel, providerId })}>Save model</button>
        <button type="button" className="btn ghost small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function EditList({ models, onSave, onHide }: { models: ChatModel[]; onSave: (id: string, patch: { label: string; upstreamModel: string }) => void; onHide: (id: string) => void }) {
  return (
    <div className="model-form">
      {models.map((model) => (
        <EditRow key={model.id} model={model} onSave={onSave} onHide={onHide} />
      ))}
    </div>
  );
}

function EditRow({ model, onSave, onHide }: { model: ChatModel; onSave: (id: string, patch: { label: string; upstreamModel: string }) => void; onHide: (id: string) => void }) {
  const [label, setLabel] = useState(model.label);
  const [upstreamModel, setUpstream] = useState(model.upstreamModel);
  return (
    <div className="edit-row">
      <input className="input" value={label} onChange={(event) => setLabel(event.target.value)} />
      <input className="input mono" value={upstreamModel} onChange={(event) => setUpstream(event.target.value)} />
      <div className="row-actions">
        <button type="button" className="btn ghost small" onClick={() => onSave(model.id, { label, upstreamModel })}>Save</button>
        <button type="button" className="btn ghost small" onClick={() => onHide(model.id)}>Hide</button>
      </div>
    </div>
  );
}
