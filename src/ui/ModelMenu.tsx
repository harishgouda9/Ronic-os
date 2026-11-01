import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ChatModel, ChatProviderLink, Effort } from "../kernel/liveChat";
import { GROUP_ORDER, groupsFor } from "../kernel/modelPrefs";
import { Check, ChevronRight, Pencil, Plus, RefreshCw, Search, Star } from "lucide-react";
import { ProviderAuth, ProviderState } from "./ProviderAuth";

function rank(group: string) {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

function hueOf(title: string) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  return hash % 360;
}

const EFFORTS: { id: Effort; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
  { id: "xhigh", label: "XHigh" },
];

type MenuItem =
  | { id: string; kind: "group"; title: string }
  | { id: string; kind: "model"; model: ChatModel };

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
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

  function toggleGroup(title: string) {
    setCollapsed((prev) => ({ ...prev, [title]: !(prev[title] ?? true) }));
  }

  // Flat list of the options currently in the DOM, in visual order — the
  // roving aria-activedescendant target for the combobox input.
  const flatItems = useMemo<MenuItem[]>(() => {
    if (mode !== "list") return [];
    const items: MenuItem[] = [];
    for (const section of sections) {
      items.push({ id: `ronic-mm-g-${section.title}`, kind: "group", title: section.title });
      const shut = !query && (collapsed[section.title] ?? true);
      if (!shut) for (const model of section.models) items.push({ id: `ronic-mm-m-${model.id}`, kind: "model", model });
    }
    return items;
  }, [sections, collapsed, query, mode]);

  useEffect(() => {
    if (!focusGroup) return;
    setCollapsed((prev) => ({ ...prev, [focusGroup]: false }));
  }, [focusGroup, focusTick]);

  // Fresh search or mode switch: the roving target restarts from the top.
  useEffect(() => {
    setActiveId(null);
  }, [query, mode]);

  // Keep the active option visible while arrowing through the list.
  useEffect(() => {
    if (!activeId) return;
    document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  // Return focus to the composer's model button when the menu closes.
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    return () => returnFocus.current?.focus?.();
  }, [open]);

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

  function moveActive(step: 1 | -1 | "first" | "last") {
    if (flatItems.length === 0) return;
    const index = flatItems.findIndex((item) => item.id === activeId);
    if (step === "first") setActiveId(flatItems[0].id);
    else if (step === "last") setActiveId(flatItems[flatItems.length - 1].id);
    else if (index === -1) setActiveId(step === 1 ? flatItems[0].id : flatItems[flatItems.length - 1].id);
    else setActiveId(flatItems[Math.min(Math.max(index + step, 0), flatItems.length - 1)].id);
  }

  function activate(item: MenuItem | undefined) {
    if (!item) return;
    if (item.kind === "group") {
      toggleGroup(item.title);
      return;
    }
    onSelect(item.model.id);
    onClose();
  }

  if (!open) return null;
  return (
    <div className="model-pop" ref={root} role="dialog" aria-label="Model picker">
      <div className="model-search">
        <Search size={14} aria-hidden="true" />
        <input
          className="input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-haspopup="listbox"
          aria-controls="ronic-model-list"
          aria-autocomplete="list"
          aria-activedescendant={activeId ?? undefined}
          aria-label="Search models"
          placeholder="Search models"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); moveActive(1); }
            else if (event.key === "ArrowUp") { event.preventDefault(); moveActive(-1); }
            else if (event.key === "Home" && flatItems.length > 0) { event.preventDefault(); moveActive("first"); }
            else if (event.key === "End" && flatItems.length > 0) { event.preventDefault(); moveActive("last"); }
            else if (event.key === "Enter") {
              event.preventDefault();
              const item = flatItems.find((entry) => entry.id === activeId);
              if (item) { activate(item); return; }
              // No roving target yet: Enter picks the only visible model.
              const visible = flatItems.filter((entry) => entry.kind === "model");
              if (visible.length === 1 && visible[0].kind === "model") { onSelect(visible[0].model.id); onClose(); }
            }
          }}
        />
      </div>
      <div className="model-scroll" id="ronic-model-list" role="listbox" aria-label="Models by provider">
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
          const groupId = `ronic-mm-g-${section.title}`;
          return (
            <section key={section.title} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected="false"
                aria-expanded={!shut}
                id={groupId}
                className={`model-group ${activeId === groupId ? "active" : ""}`}
                onClick={() => { setActiveId(groupId); toggleGroup(section.title); }}
              >
                <span className="provider-avatar" aria-hidden="true" style={{ "--h": `${hueOf(section.title)}` } as CSSProperties}>{section.title.slice(0, 1)}</span>
                <span className="provider-name">{section.title}</span>
                {section.link ? <ProviderState link={section.link} /> : null}
                <ChevronRight size={14} aria-hidden="true" className={`model-chev ${shut ? "" : "open"}`} />
              </button>
              {shut ? null : section.models.map((model) => {
                const effort = effortOf(model.id);
                const rowId = `ronic-mm-m-${model.id}`;
                const on = model.id === selectedId;
                return (
                  <div
                    key={model.id}
                    role="option"
                    id={rowId}
                    aria-selected={on}
                    className={`model-row ${on ? "on" : ""} ${activeId === rowId ? "active" : ""}`}
                    onClick={() => setActiveId(rowId)}
                  >
                    <button
                      type="button"
                      className={`star ${stars.includes(model.id) ? "on" : ""}`}
                      aria-label={stars.includes(model.id) ? `Unstar ${model.label}` : `Star ${model.label}`}
                      aria-pressed={stars.includes(model.id)}
                      onClick={(event) => { event.stopPropagation(); onStar(model.id); }}
                    >
                      <Star size={13} aria-hidden="true" />
                    </button>
                    <button type="button" className="model-name" onClick={(event) => { event.stopPropagation(); setActiveId(rowId); onSelect(model.id); onClose(); }}>{model.label}</button>
                    {on ? <Check size={13} aria-hidden="true" className="model-check" /> : null}
                    {effort !== "default" ? <span className="effort-pill">{effort === "xhigh" ? "XHIGH" : effort.toUpperCase()}</span> : null}
                    <button
                      type="button"
                      className="chev"
                      aria-label={`Reasoning effort for ${model.label}`}
                      aria-expanded={effortForId === model.id}
                      onClick={(event) => { event.stopPropagation(); setActiveId(rowId); setEffortForId((current) => current === model.id ? null : model.id); }}
                    >
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    {effortForId === model.id ? (
                      <div className="effort-menu" role="menu" aria-label={`Effort for ${model.label}`}>
                        {EFFORTS.map((item) => (
                          <button key={item.id} type="button" role="menuitem" className={item.id === effort ? "on" : ""} onClick={() => { onEffort(model.id, item.id); setEffortForId(null); }}>
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
      {status ? <p className="model-status" aria-live="polite">{status}</p> : null}
      <div className="model-foot">
        <button type="button" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw size={13} aria-hidden="true" className={refreshing ? "spin" : ""} />
          {refreshing ? "Refreshing…" : "Refresh models"}
        </button>
        <button type="button" onClick={() => onMode(mode === "add" ? "list" : "add")}>
          <Plus size={13} aria-hidden="true" />
          {mode === "add" ? "Back to models" : "Add custom model…"}
        </button>
        <button type="button" onClick={() => onMode(mode === "edit" ? "list" : "edit")}>
          <Pencil size={13} aria-hidden="true" />
          {mode === "edit" ? "Back to models" : "Edit models…"}
        </button>
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
      <label className="field"><span>Name</span><input className="input" value={label} aria-label="Model name" onChange={(event) => setLabel(event.target.value)} /></label>
      <label className="field"><span>Model id</span><input className="input" value={upstreamModel} placeholder="the provider's model id" aria-label="Provider model id" onChange={(event) => setUpstream(event.target.value)} /></label>
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
      <input className="input" value={label} aria-label={`Display name for ${model.label}`} onChange={(event) => setLabel(event.target.value)} />
      <input className="input mono" value={upstreamModel} aria-label={`Provider model id for ${model.label}`} onChange={(event) => setUpstream(event.target.value)} />
      <div className="row-actions">
        <button type="button" className="btn ghost small" onClick={() => onSave(model.id, { label, upstreamModel })}>Save</button>
        <button type="button" className="btn ghost small" onClick={() => onHide(model.id)}>Hide</button>
      </div>
    </div>
  );
}
