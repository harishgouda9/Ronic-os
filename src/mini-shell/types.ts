export interface ShellTab {
  id: string;
  url: string;
  title: string;
}

export interface ShellState {
  app: "desktop" | "chrome" | "files" | "terminal";
  tabs: ShellTab[];
  activeTab: string;
  chromeVisible: boolean;
  content: [number, number, number, number];
  dpr?: number;
  history?: string[];
  windowOpen?: boolean;
}

export interface ShellBoot {
  botId: string;
  botHandle: string;
  windowLabel: string;
  chromeLabel: string;
  workspacePath: string;
  memoryPath: string;
  sessionId: string;
  shell: ShellState;
}

export interface MiniFsEntry {
  name: string;
  kind: "dir" | "file";
  size: number;
  modifiedMs: number;
  ext: string;
}

export interface MiniFsListing {
  root: string;
  path: string;
  absolutePath: string;
  entries: MiniFsEntry[];
}

export interface MiniFsRead {
  name: string;
  kind: "text" | "image" | "media" | "binary";
  mime: string;
  size: number;
  truncated: boolean;
  text: string | null;
  base64: string | null;
}

export interface MiniComputerEvent {
  action: string;
  botId: string;
  shell: ShellState;
  instance?: unknown;
}
