// Same page as backend/api/auth/bounce.ts, for the repo-root Vercel project.

const HTML = `<!doctype html>
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
      <a id="open" href="ronic://auth/callback">Click here to finish signing in.</a>
    </p>
  </div>
  <script>
    var search = location.search.replace(/^\\?/, "");
    var hash = location.hash.replace(/^#/, "");
    var q = search && hash ? search + "&" + hash : (search || hash);
    var target = "ronic://auth/callback" + (q ? "?" + q : "");
    var link = document.getElementById("open");
    if (link) link.setAttribute("href", target);
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

export default function handler(_req, res) {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(HTML);
}
