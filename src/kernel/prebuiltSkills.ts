import type { PluginPackage, Skill, Snapshot } from "../types";
import { indexLine } from "./skillIndex";
import findSkills from "../../src-tauri/resources/builtin-skills/prebuilt/skills/find-skills/SKILL.md?raw";
import grillMe from "../../src-tauri/resources/builtin-skills/prebuilt/skills/grill-me/SKILL.md?raw";
import agentBrowser from "../../src-tauri/resources/builtin-skills/prebuilt/skills/agent-browser/SKILL.md?raw";
import improveArchitecture from "../../src-tauri/resources/builtin-skills/prebuilt/skills/improve-codebase-architecture/SKILL.md?raw";
import computerUse from "../../src-tauri/resources/builtin-skills/prebuilt/skills/computer-use/SKILL.md?raw";
import codeReview from "../../src-tauri/resources/builtin-skills/prebuilt/skills/code-review/SKILL.md?raw";
import reactPractices from "../../src-tauri/resources/builtin-skills/prebuilt/skills/vercel-react-best-practices/SKILL.md?raw";
import remotionPort from "../../src-tauri/resources/builtin-skills/prebuilt/skills/remotion-to-hyperframes/SKILL.md?raw";
import hyperframesCli from "../../src-tauri/resources/builtin-skills/prebuilt/skills/hyperframes-cli/SKILL.md?raw";
import composio from "../../src-tauri/resources/builtin-skills/prebuilt/skills/composio/SKILL.md?raw";

export const PREBUILT_PLUGIN_ID = "plug-prebuilt-skills";

const BODIES: Record<string, string> = {
  "find-skills": findSkills,
  "grill-me": grillMe,
  "agent-browser": agentBrowser,
  "improve-codebase-architecture": improveArchitecture,
  "computer-use": computerUse,
  "code-review": codeReview,
  "vercel-react-best-practices": reactPractices,
  "remotion-to-hyperframes": remotionPort,
  "hyperframes-cli": hyperframesCli,
  composio,
};

function meta(raw: string, slug: string) {
  let description = slug;
  const text = raw.trimStart();
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  if (end > 0) {
    const lines = text.slice(3, end).split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line || line.startsWith(" ") || line.startsWith("\t")) continue;
      const split = line.indexOf(":");
      if (split <= 0) continue;
      const key = line.slice(0, split).trim();
      let value = line.slice(split + 1).trim();
      if (value === ">" || value === ">-" || value === ">+" || value === "|" || value === "|-" || value === "|+") {
        const parts: string[] = [];
        i += 1;
        while (i < lines.length && (lines[i].startsWith(" ") || lines[i].startsWith("\t"))) {
          const part = lines[i].trim();
          if (part) parts.push(part);
          i += 1;
        }
        i -= 1;
        value = parts.join(" ");
      }
      value = value.replace(/^['"]|['"]$/g, "");
      if (key === "description" && value) description = value;
    }
  }
  return { description, slash: `/${slug}` };
}

function skillFor(slug: string): Skill {
  const body = BODIES[slug] ?? "";
  const parsed = meta(body, slug);
  return {
    id: `sk-${PREBUILT_PLUGIN_ID}-${slug}`,
    slug: `prebuilt-skills:${slug}`,
    origin: "plugin",
    ownerProfileId: "",
    pluginId: PREBUILT_PLUGIN_ID,
    title: slug,
    description: parsed.description,
    slashCommand: parsed.slash,
    requiresTools: [],
    platforms: [],
    body,
    files: [],
    enables: [],
    hiddenReason: "",
    indexLine: indexLine(parsed.slash, parsed.description, []),
    version: "1.0.0",
    updatedAt: 0,
  };
}

function plugin(): PluginPackage {
  return {
    id: PREBUILT_PLUGIN_ID,
    slug: "prebuilt-skills",
    name: "Prebuilt skills",
    version: "1.0.0",
    source: "builtin",
    sourcePath: "plugins/prebuilt-skills",
    trust: "trusted",
    hasAgent: true,
    hasDesktop: false,
    tools: [],
    hooks: [],
    bundledSkills: Object.keys(BODIES),
    desktop: [],
    agentEnables: [],
    desktopEnabled: false,
  };
}

export function ensurePrebuilt(state: Snapshot) {
  if (!state.plugins.some((item) => item.id === PREBUILT_PLUGIN_ID)) state.plugins.unshift(plugin());
  for (const slug of Object.keys(BODIES)) {
    const id = `sk-${PREBUILT_PLUGIN_ID}-${slug}`;
    if (!state.skills.some((skill) => skill.id === id)) state.skills.push(skillFor(slug));
  }
  const pack = state.plugins.find((item) => item.id === PREBUILT_PLUGIN_ID);
  for (const profile of state.profiles) {
    if (pack && !pack.agentEnables.some((flag) => flag.profileId === profile.id)) {
      pack.agentEnables.push({ profileId: profile.id, enabled: true });
    }
    for (const skill of state.skills) {
      if (skill.pluginId !== PREBUILT_PLUGIN_ID) continue;
      if (!skill.enables.some((flag) => flag.profileId === profile.id)) skill.enables.push({ profileId: profile.id, enabled: true });
    }
  }
}
