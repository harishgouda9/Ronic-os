import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Download,
  File as FileIcon,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  ImageIcon,
  Music,
  Pencil,
  RefreshCw,
  Trash,
  Video,
  X,
} from "lucide-react";
import { base64ToBlob, blobToBase64, errorMessage, formatBytes, formatWhen, ipc } from "../ipc";
import type { MiniFsEntry, MiniFsListing, MiniFsRead, ShellBoot } from "../types";
import { MediaTools } from "./MediaTools";

type Detail =
  | { kind: "loading"; path: string; name: string }
  | { kind: "ready"; path: string; name: string; read: MiniFsRead }
  | { kind: "media"; path: string; name: string; size: number; ext: string; blob: Blob }
  | { kind: "image"; path: string; name: string; mime: string; base64: string };

const ICONS: Record<string, typeof FileIcon> = { video: Video, audio: Music, image: ImageIcon };

function entryIcon(entry: MiniFsEntry): typeof FileIcon {
  if (entry.kind === "dir") return Folder;
  if (["mp4", "webm", "mkv", "mov", "avi"].includes(entry.ext)) return Video;
  if (["mp3", "wav", "m4a", "ogg", "flac", "aac", "opus"].includes(entry.ext)) return Music;
  if (["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif"].includes(entry.ext)) return ImageIcon;
  return FileText;
}

export function FilesApp({ boot, active, compact = false }: { boot: ShellBoot; active: boolean; compact?: boolean }) {
  const [root, setRoot] = useState<"workspace" | "memory">("workspace");
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<MiniFsListing | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"dir" | "file" | null>(null);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const rootPaths: Record<string, string> = { workspace: boot.workspacePath, memory: boot.memoryPath };

  const refresh = useCallback(
    async (whichRoot = root, whichPath = path) => {
      setBusy(true);
      try {
        setListing(await ipc.fsList(whichRoot, whichPath, boot.botId));
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [root, path],
  );

  useEffect(() => {
    if (active) void refresh(root, path);
  }, [active, root, path, refresh]);

  const open = (entry: MiniFsEntry) => {
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (entry.kind === "dir") {
      setPath(child);
      setDetail(null);
      return;
    }
    if (["mp4", "webm", "mkv", "mov", "avi", "mp3", "wav", "m4a", "ogg", "flac", "aac", "opus"].includes(entry.ext)) {
      setDetail({ kind: "loading", path: child, name: entry.name });
      void (async () => {
        try {
          const read = await ipc.fsRead(root, child, 96 * 1024 * 1024, true, boot.botId);
          if (!read.base64) throw new Error("could not read the file");
          setDetail({ kind: "media", path: child, name: entry.name, size: read.size, ext: entry.ext, blob: base64ToBlob(read.base64, read.mime) });
        } catch (e) {
          setError(errorMessage(e));
          setDetail(null);
        }
      })();
      return;
    }
    if (["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif"].includes(entry.ext)) {
      setDetail({ kind: "loading", path: child, name: entry.name });
      void (async () => {
        try {
          const read = await ipc.fsRead(root, child, undefined, undefined, boot.botId);
          if (!read.base64) throw new Error("could not read the image");
          setDetail({ kind: "image", path: child, name: entry.name, mime: read.mime, base64: read.base64 });
        } catch (e) {
          setError(errorMessage(e));
          setDetail(null);
        }
      })();
      return;
    }
    setDetail({ kind: "loading", path: child, name: entry.name });
    void (async () => {
      try {
        const read = await ipc.fsRead(root, child, undefined, undefined, boot.botId);
        setDetail({ kind: "ready", path: child, name: entry.name, read });
      } catch (e) {
        setError(errorMessage(e));
        setDetail(null);
      }
    })();
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const target = path ? `${path}/${name}` : name;
      if (creating === "dir") await ipc.fsMkdir(root, target, boot.botId);
      else await ipc.fsWrite(root, target, "", boot.botId);
      setCreating(null);
      setNewName("");
      void refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const rename = async (entry: MiniFsEntry) => {
    const next = renameValue.trim();
    setRenaming(null);
    if (!next || next === entry.name) return;
    try {
      const from = path ? `${path}/${entry.name}` : entry.name;
      const to = path ? `${path}/${next}` : next;
      await ipc.fsRename(root, from, to, boot.botId);
      if (detail && detail.path === from) setDetail({ ...detail, path: to, name: next } as Detail);
      void refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const remove = async (entry: MiniFsEntry) => {
    try {
      const target = path ? `${path}/${entry.name}` : entry.name;
      await ipc.fsDelete(root, target, boot.botId);
      if (detail && (detail.path === target || detail.path.startsWith(`${target}/`))) setDetail(null);
      void refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const crumbs = path ? path.split("/") : [];

  const rootChips = (
    <div className="msh-side-chips">
      {(["workspace", "memory"] as const).map((place) => (
        <button
          key={place}
          type="button"
          className={`msh-chip ${root === place ? "on" : ""}`}
          onClick={() => {
            setRoot(place);
            setPath("");
            setDetail(null);
          }}
        >
          {place === "workspace" ? "Workspace" : "Memory"}
        </button>
      ))}
    </div>
  );

  return (
    <div className={`msh-files ${compact ? "msh-compact-files" : ""}`}>
      {!compact ? (
      <aside className="msh-files-side">
        <p className="msh-side-label">Places</p>
        {(["workspace", "memory"] as const).map((place) => (
          <button
            key={place}
            className={`msh-side-item ${root === place ? "on" : ""}`}
            onClick={() => {
              setRoot(place);
              setPath("");
              setDetail(null);
            }}
          >
            {place === "workspace" ? <Folder size={14} aria-hidden /> : <FileIcon size={14} aria-hidden />}
            <span>{place === "workspace" ? "Workspace" : "Memory"}</span>
          </button>
        ))}
        <p className="msh-side-path" title={rootPaths[root]}>
          {rootPaths[root]}
        </p>
        <p className="msh-side-note">The workspace is shared with this bot&rsquo;s terminal and tools. Memory holds its learned lessons (EXPERIENCE.md).</p>
      </aside>
      ) : rootChips}
      <section className="msh-files-main">
        <div className="msh-files-toolbar">
          <button className="msh-tool" aria-label="Up one folder" disabled={!path} onClick={() => setPath(crumbs.slice(0, -1).join("/"))}>
            <ArrowUp size={13} aria-hidden />
          </button>
          <nav className="msh-crumbs" aria-label="Path">
            <button className="msh-crumb" onClick={() => setPath("")}>
              {root}
            </button>
            {crumbs.map((crumb, index) => (
              <button key={index} className="msh-crumb" onClick={() => setPath(crumbs.slice(0, index + 1).join("/"))}>
                {crumb}
              </button>
            ))}
          </nav>
          <button className="msh-tool" aria-label="Refresh" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw size={13} className={busy ? "msh-spin" : ""} aria-hidden />
          </button>
          <button
            className="msh-tool"
            aria-label="New folder"
            onClick={() => {
              setCreating("dir");
              setNewName("");
            }}
          >
            <FolderPlus size={13} aria-hidden />
          </button>
          <button
            className="msh-tool"
            aria-label="New file"
            onClick={() => {
              setCreating("file");
              setNewName("");
            }}
          >
            <FilePlus size={13} aria-hidden />
          </button>
        </div>
        {creating ? (
          <div className="msh-inline-row">
            <input
              autoFocus
              value={newName}
              placeholder={creating === "dir" ? "folder name" : "file name"}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void create();
                if (event.key === "Escape") setCreating(null);
              }}
            />
            <button className="msh-tool ok" aria-label="Create" onClick={() => void create()}>
              <Check size={13} aria-hidden />
            </button>
            <button className="msh-tool" aria-label="Cancel" onClick={() => setCreating(null)}>
              <X size={13} aria-hidden />
            </button>
          </div>
        ) : null}
        <div className="msh-files-body">
          <ul className="msh-list" aria-label={`${root} contents`}>
            {(listing?.entries ?? []).map((entry) => {
              const Icon = entryIcon(entry);
              const child = path ? `${path}/${entry.name}` : entry.name;
              const selected = detail?.path === child;
              return (
                <li key={entry.name} className={`msh-row ${selected ? "on" : ""}`}>
                  {renaming === entry.name ? (
                    <span className="msh-inline-row grow">
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void rename(entry);
                          if (event.key === "Escape") setRenaming(null);
                        }}
                      />
                      <button className="msh-tool ok" aria-label="Rename" onClick={() => void rename(entry)}>
                        <Check size={13} aria-hidden />
                      </button>
                    </span>
                  ) : (
                    <>
                      <button className="msh-row-main" onDoubleClick={() => open(entry)} onClick={() => entry.kind === "dir" && open(entry)}>
                        <Icon size={14} aria-hidden />
                        <span className="msh-row-name" title={entry.name}>
                          {entry.name}
                        </span>
                        <span className="msh-row-meta">
                          {entry.kind === "dir" ? "folder" : formatBytes(entry.size)} · {formatWhen(entry.modifiedMs)}
                        </span>
                      </button>
                      {entry.kind === "file" ? (
                        <button className="msh-row-act" aria-label={`Open ${entry.name}`} onClick={() => open(entry)}>
                          Open
                        </button>
                      ) : null}
                      <button
                        className="msh-row-act"
                        aria-label={`Rename ${entry.name}`}
                        onClick={() => {
                          setRenaming(entry.name);
                          setRenameValue(entry.name);
                        }}
                      >
                        <Pencil size={12} aria-hidden />
                      </button>
                      <button className="msh-row-act danger" aria-label={`Delete ${entry.name}`} onClick={() => void remove(entry)}>
                        <Trash size={12} aria-hidden />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
            {listing && listing.entries.length === 0 ? <li className="msh-empty">Empty folder</li> : null}
          </ul>
          {detail ? <DetailPane detail={detail} root={root} onClose={() => setDetail(null)} onSaved={() => void refresh()} botId={boot.botId} compact={compact} /> : null}
        </div>
      </section>
      {error ? (
        <div className="msh-toast" role="status" onClick={() => setError(null)}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

function DetailPane({ detail, root, onClose, onSaved, botId, compact }: { detail: Detail; root: string; onClose: () => void; onSaved?: () => void; botId?: string; compact?: boolean }) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (detail.kind === "ready" && loadedFor.current !== detail.path) {
      loadedFor.current = detail.path;
      setDraft(detail.read.text ?? "");
    }
  }, [detail]);

  const save = async () => {
    if (detail.kind !== "ready") return;
    setSaving(true);
    try {
      await ipc.fsWrite(root, detail.path, draft, botId);
    } catch (error) {
      alert(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const head = (
    <div className="msh-detail-head">
      <span className="msh-detail-name" title={detail.path}>
        {detail.name}
      </span>
      <button className="msh-tool" aria-label="Close preview" onClick={onClose}>
        <X size={13} aria-hidden />
      </button>
    </div>
  );

  if (detail.kind === "loading") {
    return (
      <aside className="msh-detail">
        {head}
        <p className="msh-empty">Loading…</p>
      </aside>
    );
  }
  if (detail.kind === "image") {
    return (
      <aside className="msh-detail">
        {head}
        <img className="msh-image" alt={detail.name} src={`data:${detail.mime};base64,${detail.base64}`} />
        <a className="msh-save-btn" download={detail.name} href={`data:${detail.mime};base64,${detail.base64}`}>
          <Download size={12} aria-hidden /> Save a copy
        </a>
      </aside>
    );
  }
  if (detail.kind === "media") {
    return (
      <aside className="msh-detail">
        {head}
        <MediaTools blob={detail.blob} name={detail.name} size={detail.size} root={root} path={detail.path} onSaved={onSaved} botId={botId} />
      </aside>
    );
  }
  return (
    <aside className="msh-detail">
      {head}
      <p className="msh-detail-meta">
        {detail.read.kind} · {formatBytes(detail.read.size)}
        {detail.read.truncated ? " · preview truncated" : ""}
      </p>
      {detail.read.kind === "binary" ? (
        <p className="msh-empty">Binary file — no preview.</p>
      ) : (
        <>
          <textarea
            className="msh-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            aria-label={`Edit ${detail.name}`}
          />
          <button className="msh-save-btn" disabled={saving} onClick={() => void save()}>
            <Check size={12} aria-hidden /> {saving ? "Saving…" : "Save"}
          </button>
        </>
      )}
    </aside>
  );
}
