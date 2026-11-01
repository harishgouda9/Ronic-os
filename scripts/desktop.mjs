import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { get as httpGet } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_PORT = 1420;

export function isOurDevServer(html) {
  return typeof html === "string" && html.includes("<title>Ronic OS</title>");
}

// The four states a dev launch can be in.
//   port-taken      – another program owns 1420; we must not touch it.
//   already-running – a live dev server AND a desktop window; reuse it.
//   stale-server    – a live dev server but the window died; safe to relaunch.
//   orphaned-window – the dev server is gone but an old desktop exe is still
//                     up (it renders a permanent "can't reach this page").
//                     The caller must kill that orphan before relaunching.
export function devLaunchDecision({ portBusy, ours, appRunning }) {
  if (!portBusy) return appRunning === true ? "orphaned-window" : "launch";
  if (!ours) return "port-taken";
  if (appRunning === false) return "stale-server";
  return "already-running";
}

function probeDevServer(timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    let html = "";
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = httpGet({ host: "127.0.0.1", port: DEV_PORT, path: "/" }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        html += chunk;
        if (html.length > 16384) req.destroy();
      });
      res.on("end", () => done({ busy: true, html }));
      res.on("close", () => done({ busy: true, html }));
      res.on("error", () => done({ busy: true, html }));
    });
    req.setTimeout(timeoutMs, () => {
      // A slow answer still proves a server owns the port; keep what arrived.
      req.destroy();
      done({ busy: true, html });
    });
    req.on("error", (error) => {
      // No listener refuses the connection. Anything else means it is taken.
      done({ busy: error?.code !== "ECONNREFUSED", html });
    });
  });
}

function desktopAppRunning() {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq ronicos.exe", "/NH"], { windowsHide: true }, (error, stdout) => {
      resolve(error ? null : /ronicos\.exe/i.test(stdout ?? ""));
    });
  });
}

function focusDesktopWindow() {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", "$shell = New-Object -ComObject WScript.Shell; [void]$shell.AppActivate('Ronic OS')"],
      { windowsHide: true },
      (error) => resolve(!error),
    );
  });
}

// Force-close every running desktop exe. Used to clear an orphaned window
// (one whose dev server died) so a fresh, healthy instance can take its place.
function killDesktopApp() {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("taskkill", ["/IM", "ronicos.exe", "/F"], { windowsHide: true }, () => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" | Where-Object { $_.CommandLine -like '*ronicos*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
        ],
        { windowsHide: true },
        () => resolve(true),
      );
    });
  });
}

function killPortProcess(port) {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`],
      { windowsHide: true },
      () => resolve(true),
    );
  });
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    console.error("LOCALAPPDATA is not set, so the desktop build has nowhere to write.");
    process.exit(1);
  }

  const tauriArgs = process.argv.slice(2);
  if (tauriArgs.length === 0) tauriArgs.push("dev");

  if (tauriArgs[0] === "build") {
    if (!tauriArgs.includes("--no-bundle") && !tauriArgs.includes("-b") && !tauriArgs.includes("--bundles")) {
      tauriArgs.push("--no-bundle");
    }
  }

  if (tauriArgs[0] === "dev") {
    const probe = await probeDevServer();
    const appRunning = await desktopAppRunning();
    const decision = devLaunchDecision({
      portBusy: probe.busy,
      ours: isOurDevServer(probe.html),
      appRunning,
    });
    if (decision === "already-running") {
      await focusDesktopWindow();
      console.log("Ronic OS is already running. Its window was brought to the front.");
      console.log("Close that window (or stop its terminal) before starting another copy.");
      return;
    }
    if (decision === "orphaned-window") {
      console.log(`An old Ronic OS window is still open but its dev server (port ${DEV_PORT}) is gone.`);
      console.log("Closing that stranded window so a fresh one can start...");
      await killDesktopApp();
      // Give the OS a moment to release the process before we relaunch.
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (decision === "stale-server") {
      console.log(`A leftover dev server was holding port ${DEV_PORT} while the window was closed.`);
      console.log("Cleaning up port so a fresh desktop window can start...");
      await killPortProcess(DEV_PORT);
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (decision === "port-taken") {
      console.error(`Port ${DEV_PORT} is already in use by another program, so the desktop window cannot start.`);
      console.error(`Close that program, or stop the terminal using port ${DEV_PORT}, then run it again.`);
      process.exit(1);
    }
  }

  const home = process.env.USERPROFILE || "";
  const targetDir = path.join(localAppData, "ronicos-target");
  const cargoBin = path.join(home, ".cargo", "bin");
  const gnuBin = path.join(home, ".rustup", "toolchains", "stable-x86_64-pc-windows-gnu", "bin");
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    CARGO_TERM_PROGRESS_WHEN: "never",
    PATH: [cargoBin, gnuBin, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
  };

  console.log("CARGO_TARGET_DIR=" + targetDir);
  const tauri = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const child = spawn(process.execPath, [tauri, ...tauriArgs], {
    cwd: root,
    env,
    stdio: "inherit",
    windowsHide: false,
  });
  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  child.on("exit", (code) => {
    if (code === 0 && (tauriArgs[0] === "build" || tauriArgs[0] === "dev")) {
      const mode = tauriArgs[0] === "build" ? "release" : "debug";
      const builtExe = path.join(targetDir, mode, "ronicos.exe");
      const rootExe = path.join(root, "ronicos.exe");
      if (existsSync(builtExe)) {
        try {
          copyFileSync(builtExe, rootExe);
          console.log(`Synchronized ${mode} binary to root ronicos.exe successfully.`);
        } catch (copyErr) {
          // If the exe is currently locked by a running process, ignore
        }
      }
    }
    process.exit(code ?? 1);
  });
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
