// GET /api/releases/latest — Tauri v2 updater manifest (blueprint §6.4).
//
// Values come from env so a release is a config change, not a deploy:
//   RELEASE_VERSION      e.g. 2.2.0
//   RELEASE_NOTES        markdown changelog line
//   RELEASE_WINDOWS_URL  signed .msi/.exe installer URL (R2 / GitHub Releases)
//   RELEASE_WINDOWS_SIG  minisign signature produced by the Tauri signer
//   RELEASE_MAC_URL / RELEASE_MAC_SIG / RELEASE_LINUX_URL / RELEASE_LINUX_SIG (optional)

export default async function handler(): Promise<Response> {
  const version = process.env.RELEASE_VERSION?.trim();
  if (!version) {
    return new Response(JSON.stringify({ error: "no release configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const platforms: Record<string, { signature: string; url: string }> = {};
  const windowsUrl = process.env.RELEASE_WINDOWS_URL?.trim();
  if (windowsUrl) {
    platforms["windows-x86_64"] = { signature: process.env.RELEASE_WINDOWS_SIG ?? "", url: windowsUrl };
  }
  const macUrl = process.env.RELEASE_MAC_URL?.trim();
  if (macUrl) {
    platforms["darwin-aarch64"] = { signature: process.env.RELEASE_MAC_SIG ?? "", url: macUrl };
    platforms["darwin-x86_64"] = { signature: process.env.RELEASE_MAC_SIG ?? "", url: macUrl };
  }
  const linuxUrl = process.env.RELEASE_LINUX_URL?.trim();
  if (linuxUrl) {
    platforms["linux-x86_64"] = { signature: process.env.RELEASE_LINUX_SIG ?? "", url: linuxUrl };
  }

  return new Response(
    JSON.stringify({
      version,
      notes: process.env.RELEASE_NOTES?.trim() || `Ronic OS ${version}`,
      pub_date: new Date().toISOString(),
      platforms,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=60" },
    },
  );
}
