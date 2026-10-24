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

import { execFileSync } from "node:child_process";
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
  run(testExe, args.filter((item) => item !== "--lib"), { cwd: tauriDir });
}
