// GET /api/releases/latest — Tauri v2 updater manifest (blueprint §6.4).
//
// Values come from env so a release is a config change, not a deploy:
//   RELEASE_VERSION      e.g. 2.2.0
//   RELEASE_NOTES        markdown changelog line
//   RELEASE_WINDOWS_URL  signed .msi/.exe installer URL (R2 / GitHub Releases)
//   RELEASE_WINDOWS_SIG  minisign signature produced by the Tauri signer
//   RELEASE_MAC_URL / RELEASE_MAC_SIG / RELEASE_LINUX_URL / RELEASE_LINUX_SIG (optional)
//   Architecture-specific *_AARCH64_URL / *_AARCH64_SIG values can be used
//   when a release publishes separate ARM installers.

export default async function handler(): Promise<Response> {
  const version = process.env.RELEASE_VERSION?.trim();
  if (!version) {
    return new Response(JSON.stringify({ error: "no release configured" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const platforms: Record<string, { signature: string; url: string }> = {};
  addPlatform(platforms, "windows-x86_64", "RELEASE_WINDOWS_URL", "RELEASE_WINDOWS_SIG");
  addPlatform(platforms, "windows-aarch64", "RELEASE_WINDOWS_AARCH64_URL", "RELEASE_WINDOWS_AARCH64_SIG");
  addPlatform(platforms, "darwin-x86_64", "RELEASE_MAC_URL", "RELEASE_MAC_SIG");
  addPlatform(platforms, "darwin-aarch64", "RELEASE_MAC_AARCH64_URL", "RELEASE_MAC_AARCH64_SIG", "RELEASE_MAC_URL", "RELEASE_MAC_SIG");
  addPlatform(platforms, "linux-x86_64", "RELEASE_LINUX_URL", "RELEASE_LINUX_SIG");
  addPlatform(platforms, "linux-aarch64", "RELEASE_LINUX_AARCH64_URL", "RELEASE_LINUX_AARCH64_SIG");

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

function addPlatform(
  platforms: Record<string, { signature: string; url: string }>,
  target: string,
  urlKey: string,
  signatureKey: string,
  fallbackUrlKey?: string,
  fallbackSignatureKey?: string,
) {
  const url = process.env[urlKey]?.trim() || (fallbackUrlKey ? process.env[fallbackUrlKey]?.trim() : "");
  if (!url) return;
  const signature = process.env[signatureKey]?.trim() || (fallbackSignatureKey ? process.env[fallbackSignatureKey]?.trim() : "") || "";
  platforms[target] = { signature, url };
}
