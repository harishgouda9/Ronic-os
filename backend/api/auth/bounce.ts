// GET /auth/bounce (rewritten from /api/auth/bounce) — the last hop of the
// desktop PKCE flow. Supabase redirects the system browser here with
// ?code=... (or ?error=...); this page hands the code to the desktop app via
// the ronic:// deep link. No tokens ever appear in this URL.

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.toString();
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Ronic OS — finishing sign in…</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0b0d10; color: #e7eaee;
           display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { text-align: center; max-width: 420px; padding: 32px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    p { color: #9aa3ad; font-size: 14px; line-height: 1.5; }
    a { color: #6ea8fe; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Ronic OS</h1>
    <p id="status">Sending the sign-in code back to Ronic OS…</p>
    <p id="manual" hidden>
      The desktop app did not open automatically.
      <a href="ronic://auth/callback${query ? `?${query}` : ""}">Click here to finish signing in.</a>
    </p>
  </div>
  <script>
    var q = ${JSON.stringify(query)};
    var target = "ronic://auth/callback" + (q ? "?" + q : "");
    var shown = false;
    try { location.href = target; } catch (e) { shown = true; }
    setTimeout(function () {
      document.getElementById("status").textContent =
        shown ? "The browser could not open Ronic OS." : "Still waiting for Ronic OS…";
      document.getElementById("manual").hidden = false;
    }, 2500);
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Never cache a page that carries a one-time auth code.
      "cache-control": "no-store",
    },
  });
}
