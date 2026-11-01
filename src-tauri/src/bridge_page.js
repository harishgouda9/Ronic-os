/* Host script for embedded web apps. It runs before the page and does not get Tauri IPC.
   Chat requests that contain the user's text are extended with the live workspace pack.
   The host drains window.__RONIC_OUTBOX and answers through window.__RONIC_DELIVER. */
(function () {
  if (window.__RONIC_BRIDGE === 4) return;
  window.__RONIC_BRIDGE = 4;
  var hooksArmed = false;
  window.__RONIC_OUTBOX = [];
  window.__RONIC_ARMED = "";
  window.__RONIC_PENDING = "";
  window.__RONIC_CACHE = "";
  window.__RONIC_SEEN = {};
  window.__RONIC_CHAIN = 0;
  window.__RONIC_CHAIN_AT = 0;

  window.__RONIC_DELIVER = function (id, payload) {
    var table = window.__RONIC_WAITERS || {};
    var fn = table[id];
    if (!fn) return;
    delete table[id];
    fn(payload == null ? "" : String(payload));
  };

  function bridgeRoot() {
    try {
      if (window.top && window.top.__RONIC_OUTBOX) return window.top;
    } catch (e) {}
    return window;
  }

  function bridgeCall(op, text, waitMs) {
    if (op !== "context") {
      return Promise.resolve("Embedded pages cannot run Ronic tools. Use the Ronic chat or the signed MCP bridge.");
    }
    return new Promise(function (resolve) {
      var root = bridgeRoot();
      var id = (root.__RONIC_SEQ = (root.__RONIC_SEQ || 1) + 1);
      var table = root.__RONIC_WAITERS || (root.__RONIC_WAITERS = {});
      var done = false;
      table[id] = function (payload) {
        if (done) return;
        done = true;
        resolve(payload);
      };
      root.__RONIC_OUTBOX.push({ id: id, op: "context", text: text || "" });
      setTimeout(function () {
        if (done) return;
        done = true;
        delete table[id];
        resolve("");
      }, waitMs || 1600);
    });
  }

  function composerPresent() {
    var selectors = [
      "textarea",
      "div[contenteditable='true']",
      "[role='textbox']",
      "[role='combobox']",
      "#prompt-textarea",
      ".ProseMirror",
      "[data-testid*='composer']",
      "[data-testid*='input']",
      "[data-testid*='textarea']",
      "[data-testid*='tweetTextarea']",
      "[data-testid*='grok']",
      "[placeholder*='Ask']",
      "[placeholder*='Grok']",
      "[placeholder*='Message']",
      "[placeholder*='Chat']",
      "[placeholder*='Search or ask']",
      "[aria-label*='Ask']",
      "[aria-label*='Grok']",
      "[aria-label*='Message']",
      "[aria-label*='Chat']",
      "[aria-label*='Prompt']"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var found = document.querySelector(selectors[i]);
      if (found) {
        var style = window.getComputedStyle ? window.getComputedStyle(found) : null;
        if (!style || (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0")) {
          return true;
        }
      }
    }
    return false;
  }

  function hasUserAccountIndicator() {
    var selectors = [
      "[data-testid*='user-avatar']",
      "[data-testid*='profile']",
      "[data-testid*='account']",
      "[data-testid*='SideNav_AccountSwitcher_Button']",
      "[aria-label*='Profile']",
      "[aria-label*='Account']",
      "[aria-label*='User menu']",
      "[aria-label*='Settings']",
      "[href*='/logout']",
      "[href*='/signout']",
      "button[aria-label*='User']",
      "button[aria-label*='Account']"
    ];
    for (var i = 0; i < selectors.length; i++) {
      if (document.querySelector(selectors[i])) return true;
    }
    return false;
  }

  function pageLooksBlank() {
    try {
      if ((location.protocol || "") === "about:") return true;
      var text = document.body ? String(document.body.innerText || "").replace(/\s+/g, " ").trim() : "";
      return text.length < 24 && !composerPresent();
    } catch (e) {
      return false;
    }
  }

  function authHost(hostname) {
    var host = String(hostname || "").toLowerCase();
    if (!host) return false;
    if (host === "accounts.google.com" || host.endsWith(".accounts.google.com")) return true;
    if (host === "accounts.youtube.com" || host === "appleid.apple.com") return true;
    if (host === "login.live.com" || host === "login.microsoftonline.com" || host.endsWith(".login.microsoftonline.com")) return true;
    if (host === "auth.openai.com" || host.endsWith(".auth.openai.com") || host === "auth0.com" || host.endsWith(".auth0.com")) return true;
    if (host === "okta.com" || host.endsWith(".okta.com")) return true;
    return false;
  }

  function authField(el) {
    if (!el || !el.tagName || el.tagName !== "INPUT") return false;
    var type = String(el.getAttribute("type") || "text").toLowerCase();
    var auto = String(el.getAttribute("autocomplete") || "").toLowerCase();
    var name = String(el.getAttribute("name") || el.getAttribute("id") || "").toLowerCase();
    if (type === "password" || type === "email" || type === "tel" || type === "hidden") return true;
    if (/one-time-code|username|email|current-password|new-password|webauthn/.test(auto)) return true;
    if (/(^|[_-])(code|otp|email|password|passwd|token|magic)([_-]|$)/.test(name)) return true;
    var value = String(el.value || "").trim();
    if (/^\d{4,8}$/.test(value)) return true;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
    return false;
  }

  function authSurface() {
    try {
      if (authHost(location.hostname || "")) return true;
      var path = (location.pathname || "").toLowerCase();
      if (/\/(login|signin|sign-in|oauth|authorize|verify|magic|checkpoint)(\/|$)/i.test(path)) {
        if (!composerPresent()) return true;
      }
      var gate = document.querySelector("input[type='password'], input[autocomplete='one-time-code'], input[autocomplete='username'], input[autocomplete='email'], input[inputmode='numeric']");
      if (gate && !composerPresent()) return true;
    } catch (e) {
      return true;
    }
    return false;
  }

  function authRequest(url) {
    try {
      var parsed = new URL(String(url || ""), location.href);
      if (authHost(parsed.hostname)) return true;
      return /\/(login|signin|sign-in|oauth|authorize|verify|magic|checkpoint)(\/|$)/i.test(parsed.pathname || "");
    } catch (e) {
      return true;
    }
  }

  function signedIn() {
    if (authSurface()) return false;
    if (composerPresent()) return true;
    if (hasUserAccountIndicator()) return true;
    return false;
  }

  function mayEnrich() {
    try {
      return signedIn();
    } catch (e) {
      return false;
    }
  }

  var lastKnownAuthed = null;

  function updateBadge(authed, customText) {
    var el = document.getElementById("ronic-bridge-badge");
    if (!el) {
      el = document.createElement("div");
      el.id = "ronic-bridge-badge";
      el.setAttribute("data-ronic", "bridge");
      el.onclick = handleBadgeClick;
      var parent = document.documentElement || document.body;
      if (!parent) return;
      parent.appendChild(el);
    }

    if (customText) {
      el.innerHTML = customText;
      return;
    }

    if (authed) {
      el.className = "ronic-mcp-connected";
      el.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483646;display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:9999px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:600;line-height:1.4;background:rgba(15,23,42,0.92);color:#ecfdf5;border:1px solid rgba(16,185,129,0.5);box-shadow:0 4px 16px rgba(0,0,0,0.36);cursor:pointer;user-select:none;transition:all 0.2s ease;";
      el.title = "Ronic OS MCP Bridge is Active. Click to inject workspace skills & memory into this composer.";
      el.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:#10b981;box-shadow:0 0 8px #10b981;"></span><span>MCP Connected · Ronic OS</span>';
    } else {
      el.className = "ronic-mcp-not-connected";
      el.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483646;display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:9999px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;font-weight:600;line-height:1.4;background:rgba(24,18,12,0.94);color:#fef3c7;border:1px solid rgba(245,158,11,0.55);box-shadow:0 4px 16px rgba(0,0,0,0.36);cursor:pointer;user-select:none;transition:all 0.2s ease;";
      el.title = "Ronic OS MCP Bridge Waiting. Log in to this app to link workspace memory, skills, and tools.";
      el.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:#f59e0b;box-shadow:0 0 8px #f59e0b;"></span><span>MCP: Sign in to Connect</span>';
    }

    if (lastKnownAuthed !== authed) {
      lastKnownAuthed = authed;
      try {
        var root = bridgeRoot();
        if (root && root.__RONIC_OUTBOX) {
          root.__RONIC_OUTBOX.push({
            op: "auth_status",
            signedIn: authed,
            host: location.hostname || ""
          });
        }
      } catch (e) {}
    }
  }

  function handleBadgeClick(event) {
    if (event) event.stopPropagation();
    var authed = signedIn();
    if (authed) {
      bridgeCall("context", location.origin || "").then(function (bundle) {
        var box = composerBox() || document.querySelector("textarea, [contenteditable='true']");
        if (!box) {
          updateBadge(true, '<span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:#10b981;"></span><span>Focus the chat box to inject context</span>');
          setTimeout(function () { updateBadge(true); }, 2200);
          return;
        }
        var current = box.tagName === "TEXTAREA" || box.tagName === "INPUT" ? String(box.value || "") : String(box.innerText || "");
        if (current.indexOf("[Ronic OS connection]") !== -1) {
          updateBadge(true, '<span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:#10b981;"></span><span>✓ Context already in composer</span>');
          setTimeout(function () { updateBadge(true); }, 2200);
          return;
        }
        writeBox(box, String(bundle || cachePack()) + (current ? "\n\n" + current : ""));
        updateBadge(true, '<span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:#10b981;"></span><span>✓ MCP Context Injected</span>');
        setTimeout(function () { updateBadge(true); }, 2500);
      });
    } else {
      showAuthPopup();
    }
  }

  function showAuthPopup() {
    var existing = document.getElementById("ronic-bridge-auth-modal");
    if (existing) {
      existing.remove();
      return;
    }
    var modal = document.createElement("div");
    modal.id = "ronic-bridge-auth-modal";
    modal.style.cssText = "position:fixed;right:14px;bottom:54px;z-index:2147483647;width:320px;background:#18181b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:12px;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;box-shadow:0 16px 36px rgba(0,0,0,0.6);line-height:1.4;";
    var hostName = location.hostname || "this app";
    modal.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
      '<strong style="font-size:13px;display:flex;align-items:center;gap:6px;"><span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:#f59e0b;"></span>MCP Bridge Authentication</strong>' +
      '<button id="ronic-auth-close" style="background:none;border:none;color:#a1a1aa;cursor:pointer;font-size:16px;padding:0;line-height:1;">×</button>' +
      '</div>' +
      '<p style="margin:0 0 10px;color:#d4d4d8;">Sign in to your account on <strong>' + hostName + '</strong>. Ronic OS will automatically verify your login and connect the MCP Bridge to share workspace skills and memory.</p>' +
      '<div style="display:flex;gap:8px;margin-top:12px;">' +
      '<button id="ronic-auth-check" style="flex:1;background:#2563eb;color:#ffffff;border:none;border-radius:6px;padding:7px 12px;font-size:11.5px;font-weight:600;cursor:pointer;">Check Connection Now</button>' +
      '<button id="ronic-auth-dismiss" style="background:#27272a;color:#a1a1aa;border:1px solid #3f3f46;border-radius:6px;padding:7px 12px;font-size:11.5px;cursor:pointer;">Dismiss</button>' +
      '</div>';
    var parent = document.documentElement || document.body;
    if (parent) parent.appendChild(modal);

    document.getElementById("ronic-auth-close").onclick = function () { modal.remove(); };
    document.getElementById("ronic-auth-dismiss").onclick = function () { modal.remove(); };
    document.getElementById("ronic-auth-check").onclick = function () {
      if (signedIn()) {
        modal.innerHTML = '<div style="padding:10px 0;text-align:center;"><strong style="color:#10b981;font-size:13px;">✓ MCP Connected Successfully!</strong><p style="margin:6px 0 0;color:#a1a1aa;font-size:11.5px;">Ronic OS workspace bridge is active.</p></div>';
        updateBadge(true);
        if (mayEnrich()) { try { armHooks(); } catch (e) {} }
        setTimeout(function () { modal.remove(); }, 1800);
      } else {
        var btn = document.getElementById("ronic-auth-check");
        if (btn) {
          btn.textContent = "Still waiting for login...";
          btn.style.background = "#d97706";
          setTimeout(function () {
            if (btn) {
              btn.textContent = "Check Connection Now";
              btn.style.background = "#2563eb";
            }
          }, 2000);
        }
      }
    };
  }

  function badge(text) {
    updateBadge(signedIn(), text ? '<span style="display:inline-block;width:8px;height:8px;border-radius:99px;background:#10b981;"></span><span>' + text + '</span>' : undefined);
  }

  function cachePack() {
    if (window.__RONIC_CACHE) return window.__RONIC_CACHE;
    try { return (window.top && window.top.__RONIC_CACHE) || ""; } catch (e) { return ""; }
  }

  function composerText() {
    var active = document.activeElement;
    if (authField(active)) return "";
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
      var live = String(active.value || "").trim();
      if (live) return live;
    }
    if (active && active.isContentEditable) {
      var typed = String(active.innerText || "").trim();
      if (typed) return typed;
    }
    var best = "";
    var areas = document.querySelectorAll("textarea");
    for (var i = 0; i < areas.length; i++) {
      var value = String(areas[i].value || "").trim();
      if (value.length > best.length && value.length < 20000) best = value;
    }
    var edits = document.querySelectorAll("[contenteditable='true']");
    for (var j = 0; j < edits.length; j++) {
      var block = String(edits[j].innerText || "").trim();
      if (block.length > best.length && block.length < 20000) best = block;
    }
    return best;
  }

  function remember() {
    if (!mayEnrich()) {
      window.__RONIC_ARMED = "";
      return;
    }
    var text = composerText();
    var cut = text.indexOf("[Ronic OS connection]");
    if (cut !== -1) text = text.slice(0, cut).trim();
    if (text) window.__RONIC_ARMED = text;
  }

  document.addEventListener("keydown", function (event) {
    remember();
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) stampComposer();
  }, true);
  document.addEventListener("beforeinput", remember, true);
  document.addEventListener("pointerdown", function (event) {
    remember();
    var node = event.target;
    var el = node && node.closest ? node.closest("button, [role='button']") : null;
    if (!el) return;
    var label = String(el.getAttribute("aria-label") || el.getAttribute("data-testid") || "").toLowerCase();
    if (label && label.length < 48 && /send|submit/.test(label)) stampComposer();
  }, true);
  function reloadBlankOnce() {
    try {
      if (sessionStorage.getItem("ronic-blank-reload")) return;
      var host = location.hostname || "";
      if (!/chatgpt\.com|claude\.ai|gemini\.google\.com|grok\.com|x\.com|twitter\.com|perplexity\.ai|deepseek\.com|mistral\.ai/.test(host)) return;
      if (authSurface()) return;
      if (!pageLooksBlank()) return;
      sessionStorage.setItem("ronic-blank-reload", "1");
      location.replace(location.origin + "/");
    } catch (e) {}
  }

  function showBadge() {
    var top = true;
    try { top = window.top === window; } catch (e) { top = true; }
    if (!top) return;
    var autoPromptShown = false;
    function pill() {
      if (authHost(location.hostname || "")) {
        var existing = document.getElementById("ronic-bridge-badge");
        if (existing) existing.remove();
        return;
      }
      var authed = signedIn();
      if (authed && mayEnrich()) {
        try { armHooks(); } catch (e) {}
      }
      updateBadge(authed);
      if (!authed && !autoPromptShown) {
        autoPromptShown = true;
        setTimeout(function () {
          if (!signedIn()) {
            showAuthPopup();
          }
        }, 1200);
      } else if (authed) {
        var modal = document.getElementById("ronic-bridge-auth-modal");
        if (modal) {
          modal.innerHTML = '<div style="padding:10px 0;text-align:center;"><strong style="color:#10b981;font-size:13px;">✓ MCP Connected Successfully!</strong><p style="margin:6px 0 0;color:#a1a1aa;font-size:11.5px;">Ronic OS workspace bridge is active.</p></div>';
          setTimeout(function () { modal.remove(); }, 1600);
        }
      }
    }
    pill();
    setTimeout(reloadBlankOnce, 4500);
    setInterval(pill, 2000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showBadge);
  else showBadge();

  function chatUrl(url) {
    try {
      var parsed = new URL(String(url), location.href);
      var host = parsed.hostname;
      var path = parsed.pathname || "";
      if (/analytics|telemetry|sentry|statsig|segment|amplitude|beacon|metrics|log/i.test(path)) return false;
      if (host === location.hostname) return true;
      return /claude\.ai|chatgpt\.com|openai\.com|gemini\.google\.com|grok\.com|x\.com|twitter\.com|perplexity\.ai|deepseek\.com|mistral\.ai|meta\.ai|copilot\.microsoft\.com|qwen\.ai|openrouter\.ai|nvidia\.com|tokenrouter\.io|amazonaws\.com/.test(host);
    } catch (e) {
      return false;
    }
  }

  function armedText() {
    if (!mayEnrich()) return "";
    var saved = window.__RONIC_ARMED || "";
    var cut = saved.indexOf("[Ronic OS connection]");
    if (cut !== -1) saved = saved.slice(0, cut).trim();
    var live = composerText();
    var liveCut = live.indexOf("[Ronic OS connection]");
    var value = live && liveCut === -1 ? live : saved;
    if (/^\d{4,8}$/.test(value)) return "";
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "";
    return value;
  }

  function jsonEscape(value) {
    return JSON.stringify(String(value)).slice(1, -1);
  }

  function formEncode(value) {
    return encodeURIComponent(value).replace(/%20/g, "+");
  }

  function textual(body) {
    var sample = body.slice(0, 240);
    var bad = 0;
    for (var i = 0; i < sample.length; i++) {
      var code = sample.charCodeAt(i);
      if (code === 0 || code < 9 || (code > 13 && code < 32)) bad += 1;
    }
    return bad < 3;
  }

  function carries(body, userText) {
    if (!userText || userText.length < 2) return false;
    var needles = [JSON.stringify(userText), jsonEscape(userText), encodeURIComponent(userText), formEncode(userText), encodeURIComponent(jsonEscape(userText)), formEncode(jsonEscape(userText))];
    for (var i = 0; i < needles.length; i++) {
      if (needles[i].length >= 2 && body.indexOf(needles[i]) !== -1) return true;
    }
    return false;
  }

  function splicePack(body, userText, extra) {
    if (!extra || typeof body !== "string" || !textual(body) || userText.length < 2) return body;
    if (body.indexOf("Ronic OS connection") !== -1 || body.indexOf(formEncode("Ronic OS connection")) !== -1 || body.indexOf(encodeURIComponent("Ronic OS connection")) !== -1) return body;
    var quoted = JSON.stringify(userText);
    var atQuoted = body.indexOf(quoted);
    if (atQuoted !== -1) return body.slice(0, atQuoted) + JSON.stringify(userText + extra) + body.slice(atQuoted + quoted.length);
    var pairs = [
      [jsonEscape(userText), jsonEscape(extra)],
      [encodeURIComponent(userText), encodeURIComponent(extra)],
      [formEncode(userText), formEncode(extra)],
      [encodeURIComponent(jsonEscape(userText)), encodeURIComponent(jsonEscape(extra))],
      [formEncode(jsonEscape(userText)), formEncode(jsonEscape(extra))]
    ];
    for (var i = 0; i < pairs.length; i++) {
      var needle = pairs[i][0];
      if (needle.length < 2) continue;
      var at = body.indexOf(needle);
      if (at === -1) continue;
      return body.slice(0, at + needle.length) + pairs[i][1] + body.slice(at + needle.length);
    }
    return body;
  }

  function composerBox() {
    var active = document.activeElement;
    if (active && !authField(active) && (active.tagName === "TEXTAREA" || active.isContentEditable)) return active;
    var candidates = [
      "#prompt-textarea",
      ".ProseMirror",
      "div[contenteditable='true']",
      "textarea",
      "[role='textbox']",
      "[data-testid*='composer']",
      "[data-testid*='tweetTextarea']",
      "[data-testid*='grok']",
      "[data-testid*='input']"
    ];
    for (var i = 0; i < candidates.length; i++) {
      var found = document.querySelector(candidates[i]);
      if (found && !authField(found)) {
        var style = window.getComputedStyle ? window.getComputedStyle(found) : null;
        if (!style || (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0")) {
          return found;
        }
      }
    }
    return null;
  }

  function writeBox(box, next) {
    if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
      var proto = box.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(box, next);
      else box.value = next;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    box.textContent = next;
    box.dispatchEvent(new InputEvent("input", { bubbles: true, data: next, inputType: "insertText" }));
  }

  function stampComposer() {
    if (!mayEnrich()) return;
    var box = composerBox();
    if (authField(box)) return;
    var text = box ? String(box.tagName === "TEXTAREA" || box.tagName === "INPUT" ? box.value : box.innerText || "").trim() : armedText();
    if (!text || text.indexOf("[Ronic OS connection]") !== -1) return;
    var pack = cachePack();
    if (!pack) return;
    var next = text + "\n\n" + pack;
    if (box) {
      try { writeBox(box, next); } catch (e) { return; }
    }
    badge("Ronic context attached");
  }

  function extraFor(suffix) {
    var pending = window.__RONIC_PENDING || "";
    var extra = "";
    if (pending) extra += "\n\n[Ronic tool result]\n" + pending;
    if (suffix) extra += (extra ? "\n\n" : "\n\n") + suffix;
    return { extra: extra, pending: pending };
  }

  async function bodyText(body) {
    if (body == null) return "";
    if (typeof body === "string") return body;
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return body.toString();
    if (typeof Blob !== "undefined" && body instanceof Blob) return await body.text();
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    return null;
  }

  function dropLength(headers) {
    if (!headers) return headers;
    try {
      if (typeof Headers !== "undefined" && headers instanceof Headers) {
        headers.delete("content-length");
        return headers;
      }
    } catch (e) {}
    if (Array.isArray(headers)) {
      return headers.filter(function (pair) { return String(pair[0]).toLowerCase() !== "content-length"; });
    }
    var next = {};
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() !== "content-length") next[key] = headers[key];
    }
    return next;
  }

  async function enrich(url, method, body) {
    if (!mayEnrich() || authRequest(url)) return body;
    if (!body || !chatUrl(url) || !/post|put|patch/i.test(method || "POST")) return body;
    var text = armedText();
    if (!text || text.indexOf("[Ronic tool result]") === 0) return body;
    if (!carries(body, text)) return body;
    var suffix = await bridgeCall("context", text);
    if (!suffix) suffix = cachePack();
    var packed = extraFor(suffix);
    if (!packed.extra) return body;
    var next = splicePack(body, text, packed.extra);
    if (next !== body) {
      if (packed.pending) window.__RONIC_PENDING = "";
      badge("Ronic context sent");
    }
    return next;
  }

  function armHooks() {
    if (hooksArmed || !mayEnrich()) return;
    hooksArmed = true;
    installHooks();
  }

  function installHooks() {
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      var caller = this;
      if (!mayEnrich()) return origFetch.apply(caller, arguments);
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (input && input.method) || "GET";
      if (!chatUrl(url) || authRequest(url) || !/post|put|patch/i.test(method)) return origFetch.apply(caller, arguments);
      return (async function () {
        try {
          if (typeof Request !== "undefined" && input instanceof Request && !(init && init.body)) {
            var original = await input.clone().text();
            var patched = await enrich(url, method, original);
            if (patched === original) return origFetch.call(caller, input);
            var headers = dropLength(new Headers(input.headers));
            return origFetch.call(caller, new Request(url, {
              method: method,
              headers: headers,
              body: patched,
              credentials: input.credentials,
              mode: input.mode,
              cache: input.cache,
              redirect: input.redirect,
              referrer: input.referrer
            }));
          }
          if (!init || init.body == null) return origFetch.call(caller, input, init);
          var raw = await bodyText(init.body);
          if (raw == null) return origFetch.call(caller, input, init);
          var changed = await enrich(url, method, raw);
          var nextInit = Object.assign({}, init, { body: changed, headers: dropLength(init.headers) });
          return origFetch.call(caller, input, nextInit);
        } catch (e) {
          return origFetch.apply(caller, [input, init]);
        }
      })();
    };
  }

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ronicMethod = method;
    this.__ronicUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var method = xhr.__ronicMethod || "GET";
    var url = xhr.__ronicUrl || "";
    if (!mayEnrich() || authRequest(url) || typeof body !== "string" || !chatUrl(url) || !/post|put|patch/i.test(method)) {
      return origSend.apply(this, arguments);
    }
    enrich(url, method, body).then(function (next) {
      origSend.call(xhr, next);
    }).catch(function () {
      origSend.call(xhr, body);
    });
  };

  if (typeof WebSocket === "function") {
    var wsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (!mayEnrich()) return wsSend.call(this, data);
      if (typeof data === "string" && cachePack()) {
        var text = armedText();
        if (text && text.indexOf("[Ronic tool result]") !== 0) {
          var packed = extraFor(cachePack());
          var next = splicePack(data, text, packed.extra);
          if (next !== data) {
            if (packed.pending) window.__RONIC_PENDING = "";
            badge("Ronic context sent");
            data = next;
          }
        }
      }
      return wsSend.call(this, data);
    };
  }
  }
})();

