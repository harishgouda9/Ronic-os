/* Runs in every frame of a site window, including sign-in popups.
   It does not read the page, wrap fetch, or touch cookies.
   Google rejects the sign-in when it can see window.chrome.webview or a
   client-hint brand that says WebView. */
(function () {
  function hideWebView(obj) {
    if (!obj) return false;
    var seen = false;
    try { seen = "webview" in obj; } catch (e) { return false; }
    if (!seen) return false;
    try { delete obj.webview; } catch (e) {}
    try {
      Object.defineProperty(obj, "webview", {
        configurable: true,
        enumerable: false,
        get: function () { return undefined; }
      });
    } catch (e) {}
    return true;
  }

  function hide() {
    var host = null;
    try { host = window.chrome; } catch (e) { host = null; }
    if (!hideWebView(host)) return;
    try {
      var desc = Object.getOwnPropertyDescriptor(window, "chrome");
      if (desc && desc.configurable === false) return;
      var clone = {};
      var keys = [];
      try { keys = Object.getOwnPropertyNames(host); } catch (e) { keys = []; }
      for (var i = 0; i < keys.length; i++) {
        if (keys[i] === "webview") continue;
        try {
          var prop = Object.getOwnPropertyDescriptor(host, keys[i]);
          if (prop) Object.defineProperty(clone, keys[i], prop);
        } catch (e) {}
      }
      Object.defineProperty(window, "chrome", {
        configurable: true,
        enumerable: !desc || desc.enumerable !== false,
        get: function () { return clone; }
      });
    } catch (e) {}
  }

  function scrub(list) {
    if (!list || !list.length) return list;
    var out = new Array(list.length);
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var brand = String(item.brand || "");
      if (/webview/i.test(brand)) out[i] = { brand: "Microsoft Edge", version: String(item.version || "") };
      else out[i] = item;
    }
    return out;
  }

  hide();
  try { queueMicrotask(hide); } catch (e) { try { Promise.resolve().then(hide); } catch (e2) {} }

  try {
    var proto = Navigator.prototype;
    var original = Object.getOwnPropertyDescriptor(proto, "userAgentData");
    if (original && typeof original.get === "function") {
      Object.defineProperty(proto, "userAgentData", {
        configurable: true,
        get: function () {
          var data = original.get.call(this);
          if (!data) return data;
          var wrapped = {
            brands: scrub(data.brands),
            mobile: !!data.mobile,
            platform: data.platform || "Windows"
          };
          if (typeof data.getHighEntropyValues === "function") {
            var raw = data.getHighEntropyValues.bind(data);
            wrapped.getHighEntropyValues = function (hints) {
              return raw(hints).then(function (value) {
                var copy = {};
                for (var key in value) copy[key] = value[key];
                if (copy.brands) copy.brands = scrub(copy.brands);
                if (copy.fullVersionList) copy.fullVersionList = scrub(copy.fullVersionList);
                return copy;
              });
            };
          }
          if (typeof data.toJSON === "function") wrapped.toJSON = function () { return { brands: wrapped.brands, mobile: wrapped.mobile, platform: wrapped.platform }; };
          return wrapped;
        }
      });
    }
  } catch (e) {}

  try {
    Object.defineProperty(Navigator.prototype, "webdriver", {
      configurable: true,
      get: function () { return false; }
    });
  } catch (e) {}
})();
