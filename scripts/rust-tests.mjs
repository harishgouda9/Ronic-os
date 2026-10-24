// Runner for the Rust unit tests on Windows.
//
// The tauri/wry dependency tree statically imports TaskDialogIndirect from
// comctl32.dll. That export only exists in Common-Controls v6, which a process
// gets through an embedded manifest. tauri-build embeds one into the app exe,
// but the cargo test harness exe has none, so on a clean checkout `cargo test`
// dies at startup with STATUS_ENTRYPOINT_NOT_FOUND. This script builds the
// test binary, embeds the same Common-Controls v6 manifest into it with the
// Windows SDK's mt.exe, and then runs the tests.
//
// Usage: node scripts/rust-tests.mjs [--lib]

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const targetDir = process.env.CARGO_TARGET_DIR || join(process.env.LOCALAPPDATA || "", "omniworkspace-target");
const root = join(import.meta.dirname, "..");
const tauriDir = join(root, "src-tauri");

const cargoEnv = {
  ...process.env,
  CARGO_TARGET_DIR: targetDir,
  CARGO_TERM_PROGRESS_WHEN: "never",
  PATH: [join(process.env.USERPROFILE || "", ".cargo", "bin"), process.env.PATH || ""].filter(Boolean).join(";"),
};

function run(command, cmdArgs, options = {}) {
  execFileSync(command, cmdArgs, { stdio: "inherit", ...options });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The GNU-built test exe imports api-ms-win-* DLLs by name; under a shell
// with a POSIX-style PATH (Git Bash / MSYS) the Windows loader cannot resolve
// them and the process dies with STATUS_ENTRYPOINT_NOT_FOUND before main.
// Run it with a clean Windows PATH so the result never depends on the shell
// that launched the script.
function windowsLoaderPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  const cargoBin = process.env.USERPROFILE ? join(process.env.USERPROFILE, ".cargo", "bin") : "";
  return [
    join(root, "System32"),
    root,
    join(root, "System32", "Wbem"),
    join(root, "System32", "WindowsPowerShell", "v1.0"),
    cargoBin,
  ].filter(Boolean).join(";");
}

// Console-test binaries built by the GNU toolchain can die at CRT startup
// (0xC0000139) when they inherit MSYS pipe handles from a Git Bash parent,
// before main() ever runs. Capturing and forwarding their output instead of
// inheriting handles works from every shell. A long AV-scan hold right after
// mt.exe rewrites the exe is covered by the backoff retries.
async function runTestExe(testExe, args, options) {
  const cleanEnv = { ...process.env, PATH: windowsLoaderPath() };
  const delays = [0, 3000, 8000, 15000, 25000];
  let lastError;
  for (const delay of delays) {
    if (delay) {
      console.log(`Test binary failed to load (scanner hold); retrying in ${delay / 1000}s…`);
      await sleep(delay);
    }
    try {
      const res = spawnSync(testExe, args, { ...options, env: cleanEnv, stdio: "pipe", encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      if (res.status === 0) return;
      if (res.status !== null && res.status !== 3221225781 && res.status !== 193) {
        process.exitCode = res.status ?? 1;
        return;
      }
      lastError = new Error(`test binary exited with ${res.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function findMt() {
  const kits = [
    join(process.env.ProgramFiles || "C:\\Program Files", "Windows Kits", "10", "bin"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin"),
  ];
  for (const kit of kits) {
    if (!existsSync(kit)) continue;
    const versions = readdirSync(kit).sort().reverse();
    for (const version of versions) {
      for (const arch of ["x64", "x86"]) {
        const candidate = join(kit, version, arch, "mt.exe");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function newest(pattern) {
  const dir = join(targetDir, "debug", "deps");
  let best = null;
  for (const name of readdirSync(dir)) {
    if (!pattern.test(name)) continue;
    const full = join(dir, name);
    const mtime = statSync(full).mtimeMs;
    if (!best || mtime > best.mtime) best = { full, mtime };
  }
  return best?.full ?? null;
}

const manifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>`;

run("cargo", ["test", "--lib", "--no-run", ...args], { cwd: tauriDir, env: cargoEnv });

if (process.platform !== "win32") {
  run("cargo", ["test", "--lib", ...args], { cwd: tauriDir, env: cargoEnv });
} else {
  const mt = findMt();
  if (!mt) {
    console.error("mt.exe from the Windows SDK was not found, so the test manifest could not be embedded.");
    console.error("The tests would fail at startup with STATUS_ENTRYPOINT_NOT_FOUND (missing comctl32 v6).");
    console.error("Install the Windows SDK, or run the tests from a machine profile that has mt.exe on PATH.");
    process.exit(1);
  }
  const testExe = newest(/^omniworkspace_lib-[\da-f]+\.exe$/);
  if (!testExe) {
    console.error("The lib test executable was not found after building.");
    process.exit(1);
  }
  const manifestFile = join(targetDir, "comctl6.manifest");
  writeFileSync(manifestFile, manifest, "utf8");
  run(mt, ["-manifest", manifestFile, `-outputresource:${testExe};#1`]);
  // No cwd: the repo path contains spaces and the MinGW loader fails to
  // resolve its api-set imports when the working directory has spaces.
  await runTestExe(testExe, args.filter((item) => item !== "--lib"), {});
}
