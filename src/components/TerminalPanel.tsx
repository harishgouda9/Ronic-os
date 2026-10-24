import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { isTauri } from "../api";
import { Plus, X, Terminal as TerminalIcon } from "lucide-react";

export interface TerminalTab {
  id: string;
  sessionId: string;
  title: string;
  connected?: boolean;
}

export interface TerminalPanelProps {
  sessionId?: string;
  className?: string;
  onClose?: () => void;
  title?: string;
}

export interface TerminalTabInstanceHandle {
  clear: () => void;
  restart: () => void;
  focus: () => void;
}

const isWin = typeof navigator !== "undefined" && navigator.platform.includes("Win");

const TerminalTabInstance = forwardRef<
  TerminalTabInstanceHandle,
  {
    sessionId: string;
    isActive: boolean;
    onConnectedChange: (connected: boolean) => void;
  }
>(function TerminalTabInstance({ sessionId, isActive, onConnectedChange }, ref) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermInstance = useRef<Terminal | null>(null);
  const fitAddonInstance = useRef<FitAddon | null>(null);

  useImperativeHandle(ref, () => ({
    clear: () => {
      xtermInstance.current?.clear();
    },
    restart: () => {
      if (xtermInstance.current) {
        xtermInstance.current.clear();
        if (isTauri()) {
          void import("@tauri-apps/api/core").then(({ invoke }) => {
            invoke("close_terminal", { sessionId }).finally(() => {
              if (xtermInstance.current) {
                invoke("spawn_terminal", {
                  sessionId,
                  cols: xtermInstance.current.cols || 80,
                  rows: xtermInstance.current.rows || 24,
                }).catch(() => {});
              }
            });
          });
        }
      }
    },
    focus: () => {
      xtermInstance.current?.focus();
    },
  }));

  // Re-fit and focus when this tab becomes active
  useEffect(() => {
    if (isActive && fitAddonInstance.current && xtermInstance.current && terminalRef.current) {
      const timer = setTimeout(() => {
        try {
          if (terminalRef.current && terminalRef.current.clientWidth > 0) {
            fitAddonInstance.current?.fit();
            xtermInstance.current?.focus();
            if (isTauri()) {
              void import("@tauri-apps/api/core").then(({ invoke }) => {
                invoke("resize_terminal", {
                  sessionId,
                  cols: xtermInstance.current?.cols || 80,
                  rows: xtermInstance.current?.rows || 24,
                }).catch(() => {});
              });
            }
          }
        } catch {
          /* ignore fit error during tab transition */
        }
      }, 35);
      return () => clearTimeout(timer);
    }
  }, [isActive, sessionId]);

  useEffect(() => {
    if (!terminalRef.current) return;

    // 1. Initialize xterm.js matching Ronic OS aesthetic
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 12,
      lineHeight: 1.25,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: "#0F172A",
        foreground: "#F8FAFC",
        cursor: "#10B981",
        cursorAccent: "#0F172A",
        selectionBackground: "rgba(51, 65, 85, 0.7)",
        black: "#0F172A",
        red: "#EF4444",
        green: "#10B981",
        yellow: "#F59E0B",
        blue: "#3B82F6",
        magenta: "#A855F7",
        cyan: "#06B6D4",
        white: "#F8FAFC",
        brightBlack: "#475569",
        brightRed: "#F87171",
        brightGreen: "#34D399",
        brightYellow: "#FBBF24",
        brightBlue: "#60A5FA",
        brightMagenta: "#C084FC",
        brightCyan: "#22D3EE",
        brightWhite: "#FFFFFF",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    try {
      fitAddon.fit();
    } catch {
      /* ignore fit during initial mount */
    }

    xtermInstance.current = term;
    fitAddonInstance.current = fitAddon;

    let unlisten: (() => void) | null = null;
    let disposeDataListener: (() => void) | null = null;
    let active = true;

    if (isTauri()) {
      // 2. Spawn PTY backend session in Rust
      void import("@tauri-apps/api/core").then(({ invoke }) => {
        if (!active) return;
        invoke<string>("spawn_terminal", {
          sessionId,
          cols: term.cols || 80,
          rows: term.rows || 24,
        })
          .then(() => {
            if (!active) {
              invoke("close_terminal", { sessionId }).catch(() => {});
              return;
            }
            onConnectedChange(true);
            try {
              fitAddon.fit();
              invoke("resize_terminal", {
                sessionId,
                cols: term.cols,
                rows: term.rows,
              }).catch(() => {});
            } catch {}
          })
          .catch((err) => {
            if (!active) return;
            term.writeln(`\r\n\x1b[31m[Error starting terminal]: ${err}\x1b[0m\r\n`);
          });
      });

      // 3. Listen to incoming PTY binary output chunks from Rust
      void import("@tauri-apps/api/event").then(({ listen }) => {
        if (!active) return;
        listen<number[]>(`pty-output-${sessionId}`, (event) => {
          if (!active) return;
          const uint8Array = new Uint8Array(event.payload);
          term.write(uint8Array);
        }).then((unsub) => {
          if (!active) unsub();
          else unlisten = unsub;
        });
      });

      // 4. Send user keystrokes from xterm to Rust PTY stdin
      const dataListener = term.onData((data) => {
        void import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("write_terminal", { sessionId, data }).catch(() => {});
        });
      });

      disposeDataListener = () => dataListener.dispose();
    } else {
      // Browser preview mode (when running without Tauri desktop binary)
      term.writeln("\x1b[1;36m╭─────────────────────────────────────────────────────────────╮\x1b[0m");
      term.writeln("\x1b[1;36m│\x1b[0m  \x1b[1;32mRonic OS Interactive Terminal\x1b[0m                              \x1b[1;36m│\x1b[0m");
      term.writeln("\x1b[1;36m│\x1b[0m  Real PTY with live PowerShell / Bash is active in Desktop  \x1b[1;36m│\x1b[0m");
      term.writeln("\x1b[1;36m╰─────────────────────────────────────────────────────────────╯\x1b[0m\r\n");
      term.writeln(`Session: ${sessionId}`);
      term.write("\x1b[1;32m$\x1b[0m ");
      onConnectedChange(true);

      const dataListener = term.onData((data) => {
        if (data === "\r") {
          term.write("\r\n\x1b[1;32m$\x1b[0m ");
        } else if (data === "\u007F") {
          term.write("\b \b");
        } else {
          term.write(data);
        }
      });
      disposeDataListener = () => dataListener.dispose();
    }

    // 5. Handle container and window resizing via ResizeObserver
    const handleResize = () => {
      if (fitAddonInstance.current && xtermInstance.current && terminalRef.current) {
        try {
          if (terminalRef.current.clientWidth > 0 && terminalRef.current.clientHeight > 0) {
            fitAddonInstance.current.fit();
            if (isTauri()) {
              void import("@tauri-apps/api/core").then(({ invoke }) => {
                invoke("resize_terminal", {
                  sessionId,
                  cols: term.cols,
                  rows: term.rows,
                }).catch(() => {});
              });
            }
          }
        } catch {
          /* ignore resize error */
        }
      }
    };

    window.addEventListener("resize", handleResize);

    const observer = new ResizeObserver(() => {
      handleResize();
    });
    if (terminalRef.current) {
      observer.observe(terminalRef.current);
    }

    return () => {
      active = false;
      if (unlisten) unlisten();
      if (disposeDataListener) disposeDataListener();
      window.removeEventListener("resize", handleResize);
      observer.disconnect();
      if (isTauri()) {
        void import("@tauri-apps/api/core").then(({ invoke }) => {
          invoke("close_terminal", { sessionId }).catch(() => {});
        });
      }
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div
      ref={terminalRef}
      className="w-full h-full p-2 overflow-hidden bg-[#0F172A]"
      onClick={() => xtermInstance.current?.focus()}
    />
  );
});

export default function TerminalPanel({
  sessionId = "workspace_main",
  className = "",
  onClose,
  title,
}: TerminalPanelProps) {
  const defaultShellName = title || (isWin ? "PowerShell" : "Bash");

  const [tabs, setTabs] = useState<TerminalTab[]>(() => [
    {
      id: "tab_default",
      sessionId,
      title: `${defaultShellName} 1`,
      connected: false,
    },
  ]);
  const [activeTabId, setActiveTabId] = useState<string>("tab_default");
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>("");

  const nextTabNum = useRef<number>(2);
  const tabInstances = useRef<Record<string, TerminalTabInstanceHandle>>({});

  // Keyboard shortcut Ctrl+Shift+T / Alt+T to add new tab; Ctrl+Shift+W to close tab
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "T" || e.key === "t")) {
        e.preventDefault();
        handleAddTab();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "W" || e.key === "w")) {
        e.preventDefault();
        if (activeTabId) {
          handleCloseTab(activeTabId);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTabId, tabs]);

  const handleAddTab = () => {
    const num = nextTabNum.current++;
    const newTab: TerminalTab = {
      id: `tab_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      sessionId: `${sessionId}_${num}`,
      title: `${defaultShellName} ${num}`,
      connected: false,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  };

  const handleCloseTab = (tabId: string, event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (tabs.length === 1) {
      // If only one tab left, either close drawer or restart it
      if (onClose) {
        onClose();
      } else {
        tabInstances.current[tabId]?.restart();
      }
      return;
    }

    const closedIndex = tabs.findIndex((t) => t.id === tabId);
    const newTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(newTabs);

    if (activeTabId === tabId) {
      const nextActiveIndex = Math.max(0, closedIndex - 1);
      const nextTab = newTabs[nextActiveIndex] || newTabs[0];
      if (nextTab) {
        setActiveTabId(nextTab.id);
      }
    }
  };

  const handleClearActive = () => {
    tabInstances.current[activeTabId]?.clear();
  };

  const handleRestartActive = () => {
    tabInstances.current[activeTabId]?.restart();
  };

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  return (
    <div className={`flex flex-col h-full bg-[#0F172A] border-t border-[#334155] overflow-hidden ${className}`}>
      {/* Multi-Tab Terminal Header Bar */}
      <div className="h-9 bg-[#1E293B] px-2 flex items-center justify-between text-xs text-[#94A3B8] font-mono shrink-0 select-none border-b border-[#334155] gap-2">
        {/* Left: Interactive Tabs List + Plus Button */}
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-1">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const isEditing = editingTabId === tab.id;

            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                onDoubleClick={() => {
                  setEditingTabId(tab.id);
                  setEditingTitle(tab.title);
                }}
                className={`group flex items-center gap-1.5 px-2.5 py-1 rounded cursor-pointer transition-all border text-xs max-w-[170px] shrink-0 ${
                  isActive
                    ? "bg-[#0F172A] text-[#F8FAFC] border-[#334155] font-medium shadow-xs"
                    : "bg-transparent text-[#94A3B8] border-transparent hover:bg-[#283548] hover:text-[#E2E8F0]"
                }`}
                title={`Session: ${tab.sessionId}\n(Double click to rename, stays running in background)`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 transition-colors ${
                    tab.connected ? "bg-[#10B981]" : "bg-[#F59E0B]"
                  }`}
                />
                <TerminalIcon size={12} className="shrink-0 opacity-70" />
                {isEditing ? (
                  <input
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={() => {
                      if (editingTitle.trim()) {
                        setTabs((prev) =>
                          prev.map((t) => (t.id === tab.id ? { ...t, title: editingTitle.trim() } : t))
                        );
                      }
                      setEditingTabId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (editingTitle.trim()) {
                          setTabs((prev) =>
                            prev.map((t) => (t.id === tab.id ? { ...t, title: editingTitle.trim() } : t))
                          );
                        }
                        setEditingTabId(null);
                      } else if (e.key === "Escape") {
                        setEditingTabId(null);
                      }
                    }}
                    className="bg-[#1E293B] text-[#F8FAFC] px-1 py-0.5 rounded text-xs border border-[#3B82F6] outline-none w-20"
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="truncate">{tab.title}</span>
                )}
                {tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => handleCloseTab(tab.id, e)}
                    className="opacity-0 group-hover:opacity-100 hover:text-[#EF4444] hover:bg-[#334155] rounded-full p-0.5 transition-all text-[#64748B] shrink-0 ml-0.5"
                    title="Close tab (Ctrl+Shift+W)"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            );
          })}

          {/* Plus Button to spawn new terminal tab */}
          <button
            type="button"
            onClick={handleAddTab}
            className="w-6 h-6 flex items-center justify-center rounded text-[#94A3B8] hover:text-[#F8FAFC] hover:bg-[#334155] transition-colors cursor-pointer shrink-0"
            title="New Terminal Tab (Ctrl+Shift+T)"
            aria-label="New Terminal Tab"
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Right: Actions Bar */}
        <div className="flex items-center gap-2.5 shrink-0">
          <span className="text-[#64748B] text-[11px] hidden sm:inline select-text">
            {activeTab?.sessionId}
          </span>
          <button
            type="button"
            onClick={handleClearActive}
            className="text-[#94A3B8] hover:text-[#F8FAFC] text-[11px] transition-colors cursor-pointer bg-transparent border-0"
            title="Clear active terminal tab"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={handleRestartActive}
            className="text-[#94A3B8] hover:text-[#F8FAFC] text-[11px] transition-colors cursor-pointer bg-transparent border-0"
            title="Restart active terminal session"
          >
            Restart
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-[#94A3B8] hover:text-[#F8FAFC] text-[13px] px-1 transition-colors cursor-pointer bg-transparent border-0 leading-none"
              title="Close terminal drawer (Ctrl+`)"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Terminal Tab Views: All mounted in background, only active is visible */}
      <div className="flex-1 relative overflow-hidden bg-[#0F172A]">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            style={{
              display: tab.id === activeTabId ? "flex" : "none",
              width: "100%",
              height: "100%",
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
            }}
          >
            <TerminalTabInstance
              ref={(inst) => {
                if (inst) tabInstances.current[tab.id] = inst;
                else delete tabInstances.current[tab.id];
              }}
              sessionId={tab.sessionId}
              isActive={tab.id === activeTabId}
              onConnectedChange={(connected) => {
                setTabs((prev) =>
                  prev.map((t) => (t.id === tab.id ? { ...t, connected } : t))
                );
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
