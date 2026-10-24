// Generates the Ed25519 signing pair for the Ronic OS license lease.
//
//   node scripts/generate-ed25519-keys.mjs
//
// Output:
//   1. RONIC_ED25519_PRIVATE_KEY  — JWK JSON for the Supabase Edge Function
//                                   secret (WebCrypto imports OKP JWKs).
//   2. RONIC_ED25519_PUBLIC_KEY   — base64 (standard) raw 32 bytes for the
//                                   desktop's compile-time env var.
//
// Node's webcrypto can IMPORT OKP JWKs but cannot EXPORT them, so the raw
// seed/public bytes are pulled from the stable PKCS#8/SPKI DER encodings
// (last 32 bytes each) and the JWK is assembled by hand. The script then
// proves the pair works by signing and verifying a sample lease.

import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const spki = publicKey.export({ type: "spki", format: "der" });
const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
if (spki.length !== 44 || pkcs8.length !== 48) {
  throw new Error(`unexpected Ed25519 DER sizes (spki ${spki.length}, pkcs8 ${pkcs8.length})`);
}
const publicRaw = spki.subarray(spki.length - 32);
const seedRaw = pkcs8.subarray(pkcs8.length - 32);

const b64url = (buf) => Buffer.from(buf).toString("base64url");

const jwk = JSON.stringify({
  kty: "OKP",
  crv: "Ed25519",
  d: b64url(seedRaw),
  x: b64url(publicRaw),
});

// Self-test: sign/verify the canonical lease shape both ways (Node API + the
// same JWK the Edge Function will import).
const sample = `{"user_id":"00000000-0000-0000-0000-000000000000","tier":"founder_lifetime","hardware_hash":"${createHash("sha256").update("test").digest("hex")}","max_devices":3,"iat_unix":0,"exp_unix":604800}`;
const signature = cryptoSign(null, Buffer.from(sample), privateKey);
if (!cryptoVerify(null, Buffer.from(sample), publicKey, signature)) {
  throw new Error("self-test failed: signature did not verify");
}
const { webcrypto } = await import("node:crypto");
const imported = await webcrypto.subtle.importKey("jwk", JSON.parse(jwk), { name: "Ed25519" }, false, ["sign"]);
const jwkSig = await webcrypto.subtle.sign({ name: "Ed25519" }, imported, Buffer.from(sample));
if (!Buffer.from(jwkSig).equals(signature)) {
  throw new Error("self-test failed: JWK signature differs from PKCS#8 signature");
}

console.log(`# Supabase Edge Function secret (supabase secrets set):
RONIC_ED25519_PRIVATE_KEY=${jwk}

# Desktop compile-time env (.env.production for the Tauri build):
RONIC_ED25519_PUBLIC_KEY=${Buffer.from(publicRaw).toString("base64")}

# Sample lease verified: ${sample.slice(0, 60)}…`);
