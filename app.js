(function () {
  "use strict";

  // True for touch-capable devices (iOS/iPadOS/Android/etc). Used to keep
  // the custom touch text-selection handling (and its contextmenu
  // suppression) off of mouse/trackpad devices, so right-click still works
  // normally on desktop.
  var isTouchDevice = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;

  // ---------------------------------------------------------------
  // Stable app height (see the --app-height comment in styles.css)
  // ---------------------------------------------------------------
  // Only recompute on load/rotation, never on keyboard show/hide, so the
  // editor's container doesn't resize (and steal focus from its textarea)
  // the instant the on-screen keyboard starts to animate in.
  function setStableAppHeight() {
    document.documentElement.style.setProperty("--app-height", window.innerHeight + "px");
  }
  setStableAppHeight();
  window.addEventListener("orientationchange", function () {
    setTimeout(setStableAppHeight, 50);
  });
  // A real resize (not a keyboard-driven one) still needs to update this,
  // e.g. Split View / Stage Manager resizing on iPad. Debounced and only
  // reacts to window "resize" (driven by actual layout viewport changes),
  // never visualViewport "resize" (which also fires for the keyboard).
  let appHeightResizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(appHeightResizeTimer);
    appHeightResizeTimer = setTimeout(setStableAppHeight, 150);
  });

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------

  const DEFAULT_CODE =
`// Welcome to JS Runner.
// Write JavaScript, then press Run (or Ctrl + Alt + N).

function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

for (let i = 0; i < 8; i++) {
  console.log(\`fib(\${i}) =\`, fibonacci(i));
}

const user = { name: "Ada", skills: ["math", "logic", "code"] };
console.log(user);
`;

  let editor = null;
  let monacoRef = null;
  let worker = null;
  let workerUrl = null;
  let runIdCounter = 0;
  let pendingRunId = null;
  let runTimeoutHandle = null;
  let runStartTime = 0;

  const STORAGE_KEY = "jsrunner_files_v1";
  const SETTINGS_KEY = "jsrunner_settings_v1";

  // Maps our settings.theme values to the Monaco theme names we define
  // (custom VS Code-accurate Dark+/Light+ palettes registered once Monaco loads).
  const MONACO_THEME_MAP = {
    "vs-dark": "dark-plus",
    light: "light-plus",
    "hc-black": "hc-black"
  };

  let files = [];
  let activeFileId = null;
  const fileModels = Object.create(null); // id -> Monaco model, cached so switching tabs never creates duplicate Uris
  let draggingTabId = null;
  let renamingTabId = null;

  // ---------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------

  function loadFiles() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.files) && parsed.files.length) {
          return parsed;
        }
      }
    } catch (e) {}
    return {
      files: [{ id: "f1", name: "script.js", code: DEFAULT_CODE }],
      activeFileId: "f1"
    };
  }

  function saveFiles() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ files: files, activeFileId: activeFileId }));
    } catch (e) {}
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { fontSize: 14, theme: "vs-dark", minimap: false, wordWrap: false };
  }

  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }

  let settings = loadSettings();
  document.documentElement.setAttribute("data-theme", settings.theme);

  // ---------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);
  const brandVersionEl = $("#brandVersion");
  const fileTabsEl = $("#fileTabs");
  const runBtn = $("#runBtn");
  const consoleOutput = $("#consoleOutput");
  const clearConsoleBtn = $("#clearConsoleBtn");
  const loadingScreen = $("#loadingScreen");
  const loadingText = $("#loadingText");
  const loadingRetryBtn = $("#loadingRetryBtn");
  const splitter = $("#splitter");
  const editorPane = $("#editorPane");
  const consolePane = $("#consolePane");
  const workspace = $("#workspace");
  const settingsBtn = $("#settingsBtn");
  const settingsPopover = $("#settingsPopover");
  const newFileBtn = $("#newFileBtn");
  const clearEditorBtn = $("#clearEditorBtn");
  const newFilePopover = $("#newFilePopover");
  const newFileName = $("#newFileName");
  const newFileConfirm = $("#newFileConfirm");
  const confirmOverlay = $("#confirmOverlay");
  const confirmTitle = $("#confirmTitle");
  const confirmMessage = $("#confirmMessage");
  const confirmOkBtn = $("#confirmOkBtn");
  const confirmCancelBtn = $("#confirmCancelBtn");

  // ---------------------------------------------------------------
  // Custom confirm dialog (replaces window.confirm)
  // ---------------------------------------------------------------
  let confirmResolve = null;

  function showConfirm(title, message, okLabel) {
    confirmTitle.textContent = title;
    confirmMessage.textContent = message;
    confirmOkBtn.textContent = okLabel || "Confirm";
    confirmOverlay.hidden = false;
    confirmOkBtn.focus();
    return new Promise(function (resolve) {
      confirmResolve = resolve;
    });
  }

  function resolveConfirm(result) {
    confirmOverlay.hidden = true;
    if (confirmResolve) {
      const r = confirmResolve;
      confirmResolve = null;
      r(result);
    }
  }

  confirmOkBtn.addEventListener("click", function () { resolveConfirm(true); });
  confirmCancelBtn.addEventListener("click", function () { resolveConfirm(false); });
  confirmOverlay.addEventListener("click", function (e) {
    if (e.target === confirmOverlay) resolveConfirm(false);
  });
  document.addEventListener("keydown", function (e) {
    if (confirmOverlay.hidden) return;
    if (e.key === "Escape") resolveConfirm(false);
    if (e.key === "Enter") resolveConfirm(true);
  });

  // ---------------------------------------------------------------
  // Console rendering
  // ---------------------------------------------------------------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderValue(node, topLevel) {
    if (!node) return "<span class=\"val-null\">undefined</span>";
    switch (node.t) {
      case "string":
        return topLevel
          ? escapeHtml(node.v)
          : '<span class="val-str">"' + escapeHtml(node.v) + '"</span>';
      case "number":
        return '<span class="val-num">' + escapeHtml(node.v) + "</span>";
      case "bigint":
        return '<span class="val-num">' + escapeHtml(node.v) + "</span>";
      case "boolean":
        return '<span class="val-bool">' + node.v + "</span>";
      case "null":
        return '<span class="val-null">null</span>';
      case "undefined":
        return '<span class="val-null">undefined</span>';
      case "symbol":
        return '<span class="val-fn">' + escapeHtml(node.v) + "</span>";
      case "function":
        return '<span class="val-fn">' + escapeHtml(node.v) + "</span>";
      case "error":
        return '<span class="val-str" style="color:#f48771">' + escapeHtml(node.v) + "</span>";
      case "date":
        return escapeHtml(node.v);
      case "regexp":
        return '<span class="val-fn">' + escapeHtml(node.v) + "</span>";
      case "circular":
        return escapeHtml(node.v);
      case "array": {
        const items = (node.items || []).map(function (i) { return renderValue(i, false); }).join(", ");
        const extra = node.extra ? ", … " + node.extra + " more" : "";
        return "[" + items + extra + "]";
      }
      case "map": {
        const entries = (node.entries || []).map(function (pair) {
          return renderValue(pair[0], false) + " => " + renderValue(pair[1], false);
        }).join(", ");
        return "Map(" + node.size + ") {" + entries + "}";
      }
      case "set": {
        const items = (node.items || []).map(function (i) { return renderValue(i, false); }).join(", ");
        return "Set(" + node.size + ") {" + items + "}";
      }
      case "object": {
        const prefix = node.ctor ? node.ctor + " " : "";
        const props = (node.props || []).map(function (pair) {
          return '<span class="val-key">' + escapeHtml(pair[0]) + "</span>: " + renderValue(pair[1], false);
        }).join(", ");
        const extra = node.extra ? ", … " + node.extra + " more" : "";
        return prefix + "{ " + props + extra + " }";
      }
      default:
        return escapeHtml(node.v || "");
    }
  }

  const ICONS = {
    log: "",
    info: "ℹ",
    warn: "⚠",
    error: "✕",
    result: "◀",
    system: "•",
    input: "&gt;"
  };

  function appendConsoleLine(kind, htmlBody) {
    const row = document.createElement("div");
    row.className = "console-line " + kind;
    const icon = document.createElement("span");
    icon.className = "line-icon";
    icon.innerHTML = ICONS[kind] || "";
    const body = document.createElement("span");
    body.className = "line-body";
    body.innerHTML = htmlBody;
    row.appendChild(icon);
    row.appendChild(body);
    consoleOutput.appendChild(row);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
    return row;
  }

  function logConsole(level, argNodes) {
    const html = argNodes.map(function (n) { return renderValue(n, true); }).join(" ");
    const kind = level === "warn" ? "warn" : level === "error" ? "error" : level === "info" ? "info" : "log";
    appendConsoleLine(kind, html);
  }

  function logSystem(text) {
    appendConsoleLine("system", escapeHtml(text));
  }

  function logError(err) {
    const text = err && err.stack ? err.stack : (err && err.message ? err.name + ": " + err.message : String(err));
    appendConsoleLine("error", escapeHtml(text));
  }

  function clearConsole() {
    consoleOutput.innerHTML = "";
  }

  clearConsoleBtn.addEventListener("click", clearConsole);

  // ---------------------------------------------------------------
  // Worker (sandboxed execution)
  // ---------------------------------------------------------------

  const WORKER_SRC = [
'/*',
'  Runs inside a Web Worker. Executes user JavaScript in isolation from',
'  the main thread so infinite loops or long-running code cannot freeze',
'  the UI. console.* calls and thrown errors are serialized and posted',
'  back to the main thread for display.',
'*/',
'',
'function serialize(value, depth, seen) {',
'  depth = depth || 0;',
'  seen = seen || new Set();',
'',
'  if (value === null) return { t: "null", v: "null" };',
'  if (value === undefined) return { t: "undefined", v: "undefined" };',
'',
'  const type = typeof value;',
'',
'  if (type === "string") return { t: "string", v: value };',
'  if (type === "number") return { t: "number", v: Object.is(value, -0) ? "-0" : String(value) };',
'  if (type === "boolean") return { t: "boolean", v: String(value) };',
'  if (type === "bigint") return { t: "bigint", v: value.toString() + "n" };',
'  if (type === "symbol") return { t: "symbol", v: value.toString() };',
'  if (type === "function") {',
'    const name = value.name ? value.name : "(anonymous)";',
'    const isClass = /^class\\s/.test(Function.prototype.toString.call(value));',
'    return { t: "function", v: (isClass ? "class " : "function ") + name + (isClass ? "" : "()") };',
'  }',
'',
'  if (type === "object") {',
'    if (seen.has(value)) return { t: "circular", v: "[Circular]" };',
'',
'    if (value instanceof Error) {',
'      return { t: "error", v: (value.stack || (value.name + ": " + value.message)) };',
'    }',
'    if (value instanceof Date) {',
'      return { t: "date", v: value.toISOString() };',
'    }',
'    if (value instanceof RegExp) {',
'      return { t: "regexp", v: value.toString() };',
'    }',
'    if (Array.isArray(value)) {',
'      if (depth >= 4) return { t: "array", v: "[Array]" };',
'      seen.add(value);',
'      const items = value.slice(0, 100).map(function (item) {',
'        return serialize(item, depth + 1, seen);',
'      });',
'      const extra = value.length > 100 ? value.length - 100 : 0;',
'      return { t: "array", items: items, extra: extra, len: value.length };',
'    }',
'    if (value instanceof Map) {',
'      if (depth >= 4) return { t: "map", v: "[Map]" };',
'      seen.add(value);',
'      const entries = [];',
'      let i = 0;',
'      value.forEach(function (v, k) {',
'        if (i++ < 50) entries.push([serialize(k, depth + 1, seen), serialize(v, depth + 1, seen)]);',
'      });',
'      return { t: "map", entries: entries, size: value.size };',
'    }',
'    if (value instanceof Set) {',
'      if (depth >= 4) return { t: "set", v: "[Set]" };',
'      seen.add(value);',
'      const items = [];',
'      let i = 0;',
'      value.forEach(function (v) {',
'        if (i++ < 50) items.push(serialize(v, depth + 1, seen));',
'      });',
'      return { t: "set", items: items, size: value.size };',
'    }',
'',
'    if (depth >= 4) return { t: "object", v: "[Object]" };',
'    seen.add(value);',
'    let ctorName = "";',
'    try {',
'      ctorName = value.constructor && value.constructor.name !== "Object" ? value.constructor.name : "";',
'    } catch (e) {}',
'',
'    const keys = Object.keys(value).slice(0, 100);',
'    const props = keys.map(function (k) {',
'      let v;',
'      try { v = value[k]; } catch (e) { v = undefined; }',
'      return [k, serialize(v, depth + 1, seen)];',
'    });',
'    const extra = Object.keys(value).length > 100 ? Object.keys(value).length - 100 : 0;',
'    return { t: "object", props: props, extra: extra, ctor: ctorName };',
'  }',
'',
'  return { t: "unknown", v: String(value) };',
'}',
'',
'function makeConsoleMethod(level) {',
'  return function () {',
'    const args = Array.prototype.slice.call(arguments).map(function (a) {',
'      return serialize(a, 0, new Set());',
'    });',
'    self.postMessage({ type: "console", level: level, args: args });',
'  };',
'}',
'',
'const sandboxConsole = {',
'  log: makeConsoleMethod("log"),',
'  info: makeConsoleMethod("info"),',
'  warn: makeConsoleMethod("warn"),',
'  error: makeConsoleMethod("error"),',
'  debug: makeConsoleMethod("log"),',
'  table: makeConsoleMethod("log"),',
'  group: makeConsoleMethod("info"),',
'  groupEnd: function () {},',
'  assert: function (cond) {',
'    if (!cond) {',
'      const rest = Array.prototype.slice.call(arguments, 1);',
'      makeConsoleMethod("error").apply(null, ["Assertion failed:"].concat(rest));',
'    }',
'  },',
'  time: function () {},',
'  timeEnd: function () {},',
'  clear: function () { self.postMessage({ type: "clear" }); }',
'};',
'',
'self.onmessage = function (e) {',
'  const data = e.data;',
'  if (data.type !== "run") return;',
'',
'  const runId = data.runId;',
'  const code = data.code;',
'  const mode = data.mode;',
'',
'  const g = {',
'    console: sandboxConsole,',
'    setTimeout: self.setTimeout.bind(self),',
'    clearTimeout: self.clearTimeout.bind(self),',
'    setInterval: self.setInterval.bind(self),',
'    clearInterval: self.clearInterval.bind(self),',
'    Math: Math,',
'    JSON: JSON,',
'    Date: Date,',
'    Promise: Promise,',
'    Array: Array,',
'    Object: Object,',
'    String: String,',
'    Number: Number,',
'    Boolean: Boolean,',
'    RegExp: RegExp,',
'    Map: Map,',
'    Set: Set,',
'    Symbol: Symbol,',
'    Error: Error,',
'    TypeError: TypeError,',
'    RangeError: RangeError,',
'    SyntaxError: SyntaxError,',
'    fetch: self.fetch ? self.fetch.bind(self) : undefined,',
'    self: undefined,',
'    globalThis: undefined,',
'    postMessage: undefined,',
'    importScripts: undefined',
'  };',
'',
'  try {',
'    const fnBody = mode === "eval"',
'      ? "with (__g__) { return (" + code + "); }"',
'      : "with (__g__) { " + code + "\\n}";',
'',
'    const runner = new Function("__g__", fnBody);',
'    const result = runner(g);',
'',
'    if (result instanceof Promise) {',
'      result.then(',
'        function (v) {',
'          self.postMessage({ type: "done", runId: runId, ok: true, result: mode === "eval" ? serialize(v, 0, new Set()) : null });',
'        },',
'        function (err) {',
'          self.postMessage({ type: "done", runId: runId, ok: false, error: formatError(err) });',
'        }',
'      );',
'    } else {',
'      self.postMessage({ type: "done", runId: runId, ok: true, result: mode === "eval" ? serialize(result, 0, new Set()) : null });',
'    }',
'  } catch (err) {',
'    self.postMessage({ type: "done", runId: runId, ok: false, error: formatError(err) });',
'  }',
'};',
'',
'function formatError(err) {',
'  if (err instanceof Error) {',
'    return { message: err.message, name: err.name, stack: err.stack || "" };',
'  }',
'  return { message: String(err), name: "Error", stack: "" };',
'}',
'',
'self.onerror = function (msg, src, line, col, err) {',
'  self.postMessage({ type: "console", level: "error", args: [serialize(err ? err : msg, 0, new Set())] });',
'  return true;',
'};'
  ].join('\n');

  function initWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    const blob = new Blob([WORKER_SRC], { type: "application/javascript" });
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    workerUrl = URL.createObjectURL(blob);
    worker = new Worker(workerUrl);
    worker.onmessage = handleWorkerMessage;
    worker.onerror = function (e) {
      logError({ name: "WorkerError", message: e.message || "Unknown worker error" });
      finishRun(false);
    };
  }

  function handleWorkerMessage(e) {
    const data = e.data;
    if (data.type === "console") {
      logConsole(data.level, data.args);
    } else if (data.type === "clear") {
      clearConsole();
    } else if (data.type === "done") {
      if (data.runId !== pendingRunId) return;
      clearTimeout(runTimeoutHandle);
      if (data.ok) {
        if (data.result) {
          appendConsoleLine("result", renderValue(data.result, false));
        }
        finishRun(true);
      } else {
        logError(data.error);
        finishRun(false);
      }
    }
  }

  function formatDuration(ms) {
    if (ms >= 1000) {
      return (ms / 1000).toFixed(2) + "s";
    }
    return ms.toFixed(2) + "ms";
  }

  function finishRun(ok) {
    pendingRunId = null;
    runBtn.classList.remove("running");
    runBtn.querySelector("span").textContent = "Run";
    if (ok) {
      const elapsed = performance.now() - runStartTime;
      logSystem("Finished in " + formatDuration(elapsed));
    }
  }

  function runCode() {
    if (!editor) return;
    if (!worker) {
      logSystem("Sandbox is still starting up, try again in a moment.");
      return;
    }
    const code = editor.getValue();

    if (pendingRunId !== null) {
      // Previous run still going (likely an infinite loop) — hard reset the worker.
      initWorker();
    }

    clearConsole();
    logSystem("Running " + getActiveFile().name + " …");

    runBtn.classList.add("running");
    runBtn.querySelector("span").textContent = "Running…";

    const runId = ++runIdCounter;
    pendingRunId = runId;
    runStartTime = performance.now();

    runTimeoutHandle = setTimeout(function () {
      if (pendingRunId === runId) {
        logError({ name: "TimeoutError", message: "Execution took too long (possible infinite loop) and was stopped after 8s." });
        initWorker();
        finishRun(false);
      }
    }, 8000);

    worker.postMessage({ type: "run", mode: "run", code: code, runId: runId });
  }

  function evalExpression(expr) {
    if (!worker) {
      logSystem("Sandbox is still starting up, try again in a moment.");
      return;
    }
    appendConsoleLine("input", escapeHtml(expr));
    const runId = ++runIdCounter;
    pendingRunId = runId;
    const to = setTimeout(function () {
      if (pendingRunId === runId) {
        logError({ name: "TimeoutError", message: "Expression took too long and was stopped." });
        initWorker();
        pendingRunId = null;
      }
    }, 4000);

    const originalHandler = worker.onmessage;
    worker.onmessage = function (e) {
      const data = e.data;
      if (data.type === "console") {
        logConsole(data.level, data.args);
        return;
      }
      if (data.type === "clear") { clearConsole(); return; }
      if (data.type === "done" && data.runId === runId) {
        clearTimeout(to);
        worker.onmessage = originalHandler;
        pendingRunId = null;
        if (data.ok) {
          if (data.result) appendConsoleLine("result", renderValue(data.result, false));
        } else {
          logError(data.error);
        }
      }
    };

    worker.postMessage({ type: "run", mode: "eval", code: expr, runId: runId });
  }

  // ---------------------------------------------------------------
  // File tabs
  // ---------------------------------------------------------------

  function getActiveFile() {
    return files.find(function (f) { return f.id === activeFileId; }) || files[0];
  }

  // Every file gets exactly one Monaco model for its whole lifetime, cached
  // here and reused on every switch. The Uri includes the file id (stable,
  // unique, never reused even after renames) so Monaco never sees a
  // duplicate Uri, which is what silently broke repeated tab switches before.
  function getOrCreateModel(f) {
    let model = fileModels[f.id];
    if (model && !model.isDisposed()) return model;
    model = monacoRef.editor.createModel(f.code, "javascript", monacoRef.Uri.parse("file:///" + f.id + "/" + f.name));
    fileModels[f.id] = model;
    return model;
  }

  function disposeModel(id) {
    const model = fileModels[id];
    if (model) {
      if (!model.isDisposed()) model.dispose();
      delete fileModels[id];
    }
  }

  function renderTabs() {
    fileTabsEl.innerHTML = "";
    files.forEach(function (f) {
      const tab = document.createElement("div");
      tab.className = "file-tab" + (f.id === activeFileId ? " active" : "") + (f.id === draggingTabId ? " dragging" : "");
      tab.dataset.id = f.id;
      tab.draggable = renamingTabId !== f.id;

      const dot = document.createElement("span");
      dot.className = "tab-dot";
      tab.appendChild(dot);

      if (f.id === renamingTabId) {
        const input = document.createElement("input");
        input.className = "tab-name-input";
        input.type = "text";
        input.value = f.name;
        input.spellcheck = false;
        input.autocapitalize = "off";
        tab.appendChild(input);

        function commit() {
          const val = input.value.trim();
          if (val) renameFile(f.id, val);
          renamingTabId = null;
          renderTabs();
        }
        function cancel() {
          renamingTabId = null;
          renderTabs();
        }
        input.addEventListener("keydown", function (ev) {
          ev.stopPropagation();
          if (ev.key === "Enter") { ev.preventDefault(); commit(); }
          else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
        });
        input.addEventListener("click", function (ev) { ev.stopPropagation(); });
        input.addEventListener("blur", commit);
        setTimeout(function () { input.focus(); input.select(); }, 0);
      } else {
        const name = document.createElement("span");
        name.className = "tab-name";
        name.textContent = f.name;
        name.addEventListener("dblclick", function (ev) {
          ev.stopPropagation();
          renamingTabId = f.id;
          renderTabs();
        });
        tab.appendChild(name);
      }

      if (files.length > 1) {
        const close = document.createElement("span");
        close.className = "tab-close";
        close.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>';
        close.addEventListener("click", function (ev) {
          ev.stopPropagation();
          closeFile(f.id);
        });
        tab.appendChild(close);
      }

      tab.addEventListener("click", function () {
        if (renamingTabId && renamingTabId !== f.id) return;
        switchToFile(f.id);
      });

      // Keyboard rename trigger: F2 on a focused/active tab.
      tab.tabIndex = 0;
      tab.addEventListener("keydown", function (ev) {
        if (ev.key === "F2" && renamingTabId !== f.id) {
          ev.preventDefault();
          renamingTabId = f.id;
          renderTabs();
        }
      });

      attachDragHandlers(tab, f.id);
      fileTabsEl.appendChild(tab);
    });
  }

  // --- Drag to reorder, with a FLIP animation on drop ---
  function attachDragHandlers(tab, id) {
    tab.addEventListener("dragstart", function (ev) {
      draggingTabId = id;
      tab.classList.add("dragging");
      ev.dataTransfer.effectAllowed = "move";
      try { ev.dataTransfer.setData("text/plain", id); } catch (e) {}
    });

    tab.addEventListener("dragend", function () {
      draggingTabId = null;
      renderTabs();
    });

    tab.addEventListener("dragover", function (ev) {
      if (!draggingTabId || draggingTabId === id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      const rect = tab.getBoundingClientRect();
      const before = ev.clientX < rect.left + rect.width / 2;
      const fromIdx = files.findIndex(function (f) { return f.id === draggingTabId; });
      const toIdx = files.findIndex(function (f) { return f.id === id; });
      if (fromIdx === -1 || toIdx === -1) return;
      const targetIdx = before ? toIdx : toIdx + 1;
      const insertIdx = targetIdx > fromIdx ? targetIdx - 1 : targetIdx;
      if (insertIdx === fromIdx) return;
      reorderFiles(fromIdx, insertIdx);
    });

    tab.addEventListener("drop", function (ev) {
      ev.preventDefault();
    });
  }

  function reorderFiles(fromIdx, toIdx) {
    const firstRects = recordTabRects();
    const [moved] = files.splice(fromIdx, 1);
    files.splice(toIdx, 0, moved);
    renderTabs();
    playFlipAnimation(firstRects);
    saveFiles();
  }

  function recordTabRects() {
    const rects = {};
    fileTabsEl.querySelectorAll(".file-tab").forEach(function (el) {
      rects[el.dataset.id] = el.getBoundingClientRect();
    });
    return rects;
  }

  function playFlipAnimation(firstRects) {
    fileTabsEl.querySelectorAll(".file-tab").forEach(function (el) {
      const first = firstRects[el.dataset.id];
      if (!first) return;
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      if (!dx) return;
      el.style.transition = "none";
      el.style.transform = "translateX(" + dx + "px)";
      requestAnimationFrame(function () {
        el.style.transition = "transform 180ms ease";
        el.style.transform = "";
      });
      el.addEventListener("transitionend", function handler() {
        el.style.transition = "";
        el.removeEventListener("transitionend", handler);
      });
    });
  }

  function renameFile(id, newName) {
    const f = files.find(function (x) { return x.id === id; });
    if (!f) return;
    if (!/\.jsx?$/.test(newName)) newName += ".js";
    f.name = newName;
    saveFiles();
  }

  function switchToFile(id) {
    if (id === activeFileId) return;
    saveCurrentEditorValue();
    activeFileId = id;
    const f = getActiveFile();
    const model = getOrCreateModel(f);
    editor.setModel(model);
    renderTabs();
    saveFiles();
  }

  function saveCurrentEditorValue() {
    const f = getActiveFile();
    if (f && editor) f.code = editor.getValue();
  }

  async function closeFile(id) {
    const idx = files.findIndex(function (f) { return f.id === id; });
    if (idx === -1 || files.length <= 1) return;
    const f = files[idx];
    if (f.code && f.code.trim()) {
      const ok = await showConfirm('Close "' + f.name + '"?', "This can't be undone.", "Close");
      if (!ok) return;
    }
    // Re-check in case files changed while the dialog was open.
    const idx2 = files.findIndex(function (x) { return x.id === id; });
    if (idx2 === -1 || files.length <= 1) return;
    if (activeFileId === id) saveCurrentEditorValue();
    files.splice(idx2, 1);
    disposeModel(id);
    if (activeFileId === id) {
      const next = files[Math.max(0, idx2 - 1)];
      activeFileId = next.id;
      const model = getOrCreateModel(next);
      editor.setModel(model);
    }
    renderTabs();
    saveFiles();
  }

  function createFile(name) {
    if (!name) return;
    if (!/\.jsx?$/.test(name)) name += ".js";
    const id = "f" + Date.now();
    const newFile = { id: id, name: name, code: "" };
    files.push(newFile);
    saveCurrentEditorValue();
    activeFileId = id;
    const model = getOrCreateModel(newFile);
    editor.setModel(model);
    renderTabs();
    saveFiles();
    editor.focus();
  }

  newFileBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    closeAllPopovers();
    newFilePopover.hidden = false;
    newFileName.value = "";
    newFileName.focus();
  });

  newFileConfirm.addEventListener("click", function () {
    createFile(newFileName.value.trim());
    newFilePopover.hidden = true;
  });

  newFileName.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { createFile(newFileName.value.trim()); newFilePopover.hidden = true; }
    if (e.key === "Escape") { newFilePopover.hidden = true; }
  });

  async function clearEditor() {
    if (!editor) return;
    if (!editor.getValue()) return;
    const ok = await showConfirm("Clear editor?", "This can't be undone.", "Clear");
    if (!ok) return;
    editor.setValue("");
    editor.focus();
    logSystem("Editor cleared.");
  }

  clearEditorBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    closeAllPopovers();
    clearEditor();
  });

// ---------------------------------------------------------------
  // Update / refresh app (PWA: clear caches, unregister service
  // workers, then hard-reload so the home-screen app picks up the
  // latest deployed version instead of a stale cached copy).
  // ---------------------------------------------------------------

  const updateAppBtn = $("#updateAppBtn");

  async function refreshApp() {
    const icon = updateAppBtn.querySelector("svg");
    updateAppBtn.disabled = true;
    if (icon) icon.style.animation = "spin 0.8s linear infinite";
    logSystem("Checking for updates…");

    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(function (r) { return r.unregister(); }));
      }
      if (window.caches && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }
    } catch (e) {
      log("refreshApp: cache/SW cleanup failed: " + e.message);
    }

    // Bust any cached index.html / app.js via a query param, since some
    // hosts (and iOS "Add to Home Screen") cache aggressively even
    // without a service worker.
    const url = new URL(window.location.href);
    url.searchParams.set("_r", Date.now());
    window.location.replace(url.toString());
  }

  updateAppBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    closeAllPopovers();
    refreshApp();
  });

  // ---------------------------------------------------------------
  // Auto-detect stale version on resume
  // ---------------------------------------------------------------
  // On iOS, a home-screen "standalone" app is kept alive by the OS as a
  // suspended process rather than actually closed when you leave it —
  // closer to how a native app backgrounds than how a browser tab
  // discards. Reopening it resumes that same suspended page instead of
  // re-requesting anything, so it can silently keep showing an old
  // deployed version indefinitely (only an actual device restart, or a
  // long enough idle time for iOS to fully evict the process, forces a
  // real reload). The manual "refresh" button covers the ad-hoc case;
  // this covers it automatically every time the app is reopened/resumed,
  // so people don't have to remember to tap it.
  //
  // On every resume, fetch a cache-busted copy of index.html (small,
  // cheap) and compare its embedded version string to the one currently
  // rendered on screen. If they differ, silently do the same cache-clear
  // + hard reload the manual button does.
  const versionStatusEl = $("#versionStatus");

  function setVersionStatus(state, label, title) {
    if (!versionStatusEl) return;
    versionStatusEl.dataset.state = state;
    versionStatusEl.title = title || label;
    const labelEl = versionStatusEl.querySelector(".version-status-label");
    if (labelEl) labelEl.textContent = label;
  }

  versionStatusEl && versionStatusEl.addEventListener("click", function () {
    if (versionStatusEl.dataset.state === "stale") refreshApp();
  });

  async function checkForStaleVersion() {
    setVersionStatus("checking", "Checking…", "Checking for updates…");
    try {
      const url = new URL("index.html", window.location.href);
      url.searchParams.set("_v", Date.now());
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) {
        setVersionStatus("offline", "Offline", "Couldn't check for updates.");
        return;
      }
      const html = await res.text();
      const match = html.match(/id="brandVersion">([^<]+)</);
      const latestVersion = match ? match[1].trim() : null;
      const currentVersion = brandVersionEl ? brandVersionEl.textContent.trim() : null;

      if (latestVersion && currentVersion && latestVersion !== currentVersion) {
        setVersionStatus("stale", "Update ready", "A newer version (" + latestVersion + ") is ready. Tap to update.");
        logSystem("Newer version detected (" + currentVersion + " -> " + latestVersion + "). Updating...");
        await refreshApp();
      } else {
        setVersionStatus("latest", "Up to date", "You're on the latest version (" + currentVersion + ").");
      }
    } catch (e) {
      setVersionStatus("offline", "Offline", "Couldn't check for updates (offline?).");
      log("checkForStaleVersion failed: " + e.message);
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") checkForStaleVersion();
  });
  // pageshow with persisted=true fires specifically when a page is restored
  // from the (b)f-cache / suspended state rather than freshly loaded —
  // exactly the iOS standalone-resume case this is aimed at.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) checkForStaleVersion();
  });
  // Also check once shortly after each fresh load, in case this very
  // load was itself served from a stale WKWebView disk cache.
  setTimeout(checkForStaleVersion, 1500);

  // ---------------------------------------------------------------
  // Settings popover
  // ---------------------------------------------------------------

  function closeAllPopovers() {
    settingsPopover.hidden = true;
    newFilePopover.hidden = true;
  }

  settingsBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    const wasHidden = settingsPopover.hidden;
    closeAllPopovers();
    settingsPopover.hidden = !wasHidden;
  });

  document.addEventListener("click", function (e) {
    if (!settingsPopover.hidden && !settingsPopover.contains(e.target) && e.target !== settingsBtn) {
      settingsPopover.hidden = true;
    }
    if (!newFilePopover.hidden && !newFilePopover.contains(e.target) && e.target !== newFileBtn) {
      newFilePopover.hidden = true;
    }
  });

  function applyAppTheme() {
    document.documentElement.setAttribute("data-theme", settings.theme);
  }

  function applySettingsToEditor() {
    applyAppTheme();
    if (!editor) return;
    editor.updateOptions({
      fontSize: settings.fontSize,
      minimap: { enabled: settings.minimap },
      wordWrap: settings.wordWrap ? "on" : "off"
    });
    monacoRef.editor.setTheme(MONACO_THEME_MAP[settings.theme] || settings.theme);
  }

  const fontSizeRange = $("#fontSizeRange");
  const fontSizeValue = $("#fontSizeValue");
  const themeSelect = $("#themeSelect");
  const minimapToggle = $("#minimapToggle");
  const wordWrapToggle = $("#wordWrapToggle");

  fontSizeRange.value = settings.fontSize;
  fontSizeValue.textContent = settings.fontSize;
  themeSelect.value = settings.theme;
  minimapToggle.checked = settings.minimap;
  wordWrapToggle.checked = settings.wordWrap;

  fontSizeRange.addEventListener("input", function () {
    settings.fontSize = parseInt(fontSizeRange.value, 10);
    fontSizeValue.textContent = settings.fontSize;
    applySettingsToEditor();
    saveSettings(settings);
  });

  themeSelect.addEventListener("change", function () {
    settings.theme = themeSelect.value;
    applySettingsToEditor();
    saveSettings(settings);
  });

  minimapToggle.addEventListener("change", function () {
    settings.minimap = minimapToggle.checked;
    applySettingsToEditor();
    saveSettings(settings);
  });

  wordWrapToggle.addEventListener("change", function () {
    settings.wordWrap = wordWrapToggle.checked;
    applySettingsToEditor();
    saveSettings(settings);
  });

  // ---------------------------------------------------------------
  // Resizable split
  // ---------------------------------------------------------------

  (function setupSplitter() {
    let dragging = false;

    function onDown(clientY) {
      dragging = true;
      splitter.classList.add("dragging");
    }
    function onMove(clientY) {
      if (!dragging) return;
      const rect = workspace.getBoundingClientRect();
      const total = rect.height;
      let editorH = clientY - rect.top;
      const min = 80;
      editorH = Math.max(min, Math.min(total - min - splitter.offsetHeight, editorH));
      const consoleH = total - editorH - splitter.offsetHeight;
      editorPane.style.flex = "0 0 " + editorH + "px";
      consolePane.style.flex = "0 0 " + consoleH + "px";
      if (editor) editor.layout();
    }
    function onUp() {
      dragging = false;
      splitter.classList.remove("dragging");
    }

    splitter.addEventListener("mousedown", function (e) { onDown(e.clientY); e.preventDefault(); });
    window.addEventListener("mousemove", function (e) { onMove(e.clientY); });
    window.addEventListener("mouseup", onUp);

    splitter.addEventListener("touchstart", function (e) { onDown(e.touches[0].clientY); }, { passive: true });
    window.addEventListener("touchmove", function (e) { if (dragging) { onMove(e.touches[0].clientY); e.preventDefault(); } }, { passive: false });
    window.addEventListener("touchend", onUp);
  })();

  window.addEventListener("resize", function () { if (editor) editor.layout(); });

  // ---------------------------------------------------------------
  // Console input (REPL-style expression eval)
  // ---------------------------------------------------------------

  const inputHistory = [];
  let historyIdx = -1;

  // ---------------------------------------------------------------
  // Block the browser's native save dialog everywhere on the page.
  // Autosave already persists every change, so Ctrl+S has
  // nothing to do here beyond stopping the browser's own handling.
  // ---------------------------------------------------------------

  window.addEventListener("keydown", function (e) {
    const key = e.key ? e.key.toLowerCase() : "";
    if ((e.ctrlKey || e.metaKey) && key === "s") {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // ---------------------------------------------------------------
  // Run button
  // ---------------------------------------------------------------

  runBtn.addEventListener("click", runCode);

  // --- iOS/iPadOS touch text-selection fix ---------------------------------
  // Native Safari's long-press callout ("Copy/Look Up/Share...") fights with
  // Monaco's own input handling, so we suppress just that OS-level gesture.
  // Everything else — single tap to place the cursor, drag to select, and
  // opening the on-screen keyboard — is left to Monaco's built-in touch
  // handling, which already does this correctly. We only *add* a lightweight
  // double-tap handler on top, for a custom Cut/Copy/Paste menu.
  //
  // IMPORTANT: focusing the editor (to raise the keyboard, especially in
  // standalone/home-screen mode) only works when done synchronously inside
  // the event that the user directly triggered. Never defer editor.focus()
  // into a setTimeout/promise — iOS Safari will silently refuse to show the
  // keyboard if it does.
  function setupIOSTouchTextHandling(editor) {
    if (!isTouchDevice) return;

    const domNode = editor.getDomNode();
    if (!domNode) return;

    // Kill the native callout menu, but do NOT disable webkitUserSelect or
    // otherwise touch Monaco's own touch/pointer handling — that's what
    // lets a tap place the cursor and a drag select text.
    domNode.style.webkitTouchCallout = "none";
    domNode.addEventListener("contextmenu", (e) => e.preventDefault());

    const textarea = domNode.querySelector("textarea.inputarea");
    if (textarea) {
      textarea.style.webkitTouchCallout = "none";
      textarea.addEventListener("contextmenu", (e) => e.preventDefault());
    }

    // Close the Cut/Copy/Paste/Select menu as soon as the user starts
    // typing, backspacing, or otherwise editing/moving via the keyboard -
    // it's meant to disappear the instant text input resumes, not linger
    // until an unrelated tap elsewhere dismisses it.
    editor.onDidChangeModelContent(function () {
      const openMenu = document.getElementById("editorTouchMenu");
      if (openMenu) closeEditorTouchMenu(openMenu);
    });
    editor.onKeyDown(function () {
      const openMenu = document.getElementById("editorTouchMenu");
      if (openMenu) closeEditorTouchMenu(openMenu);
    });

    // Double-tap detection only, purely additive: this never calls
    // preventDefault() on touchstart or on a single-tap touchend, so
    // Monaco's native tap-to-position and keyboard-raising behavior fires
    // exactly as it normally would.
    let touchStart = null;
    let lastTapTime = 0;
    let lastTapPos = null;
    let tapCount = 0;

    // Tracks whether Monaco changed the selection to something non-empty
    // on its own (its native double-tap-to-select-word gesture) during the
    // current touch, since our last explicit setSelection/setPosition
    // call. This is reset at the start of every touch and only set by
    // Monaco's own event, so - unlike re-reading editor.getSelection() at
    // touchend, which can just as easily still be reporting a stale
    // selection from BEFORE this tap collapsed it - it can only ever be
    // true because Monaco itself just selected something during this
    // exact touch.
    let nativeSelectionDuringTouch = false;
    editor.onDidChangeCursorSelection((ev) => {
      if (!ev.selection.isEmpty()) nativeSelectionDuringTouch = true;
    });

    const posFromTouch = (touch) => {
      const target = editor.getTargetAtClientPoint(touch.clientX, touch.clientY);
      return target && target.position ? target.position : null;
    };

    // Monaco's getTargetAtClientPoint always clamps to the nearest valid
    // document position, both horizontally (past end of a line) and
    // vertically (below the last line, or above the first). That means a
    // tap well below a single line of code can still resolve to that same
    // line/column as the cursor, even though the tap visually landed
    // nowhere near that row. Checking target.position.lineNumber alone
    // doesn't catch this, since it's the clamped value. Instead we check
    // the tap's actual Y coordinate against the pixel bounds of the
    // cursor's line, using the editor's own row geometry, so only a tap
    // that visually falls within that row counts as "on the cursor's row."
    const isTouchYInLineRow = (touch, lineNumber) => {
      const domRect = domNode.getBoundingClientRect();
      const contentTop = domRect.top + editor.getTopForLineNumber(lineNumber) - editor.getScrollTop();
      const lineHeight = editor.getOption(window.monaco.editor.EditorOption.lineHeight);
      const y = touch.clientY;
      return y >= contentTop && y < contentTop + lineHeight;
    };

    domNode.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      touchStart = { x: touch.clientX, y: touch.clientY, time: Date.now() };
      nativeSelectionDuringTouch = false;

      // Close any open menu right away, on touchstart rather than waiting
      // for touchend. This matters when the new tap visually lands on/near
      // where the still-open menu is floating: closing it here, before the
      // finger even lifts, means the menu's pointer-events are already
      // being turned off (see is-closing in styles.css) by the time this
      // same touch would otherwise have been intercepted by the menu's own
      // DOM instead of reaching the editor underneath.
      const openMenu = document.getElementById("editorTouchMenu");
      if (openMenu) closeEditorTouchMenu(openMenu);
    }, { passive: true });

    domNode.addEventListener("touchend", (e) => {
      if (!touchStart) return;

      const touch = e.changedTouches[0];
      const dt = Date.now() - touchStart.time;
      const dx = Math.abs(touch.clientX - touchStart.x);
      const dy = Math.abs(touch.clientY - touchStart.y);
      const wasTap = dt < 300 && dx < 6 && dy < 6;

      if (wasTap) {
        const now = Date.now();
        const isCloseToLastTap =
          lastTapPos &&
          Math.abs(touch.clientX - lastTapPos.x) < 20 &&
          Math.abs(touch.clientY - lastTapPos.y) < 20;
        const isPartOfTapSequence = now - lastTapTime < 300 && isCloseToLastTap;

        // Menu (if any) was already closed in touchstart above, so a tap
        // landing on/near it is not intercepted by its own DOM.

        const isDoubleTap = isPartOfTapSequence;
        // A third tap landing in the same spot within the same window as
        // the second — i.e. right after we've just handled a double-tap.
        const isTripleTap = isDoubleTap && tapCount === 2;

        // Tapping exactly where the cursor already is (editor focused,
        // cursor visibly blinking there, nothing currently selected) opens
        // the menu directly with no selection change. This requires an
        // EXACT column match on the cursor's line, AND the tap must
        // visually land within that line's row (not just resolve there via
        // Monaco's position clamping). A tap below the cursor's row just
        // moves the cursor to the clamped position, same as before, and
        // the menu does not open.
        let isTapOnExistingCursor = false;
        if (!isDoubleTap && editor.hasTextFocus()) {
          const pos = posFromTouch(touch);
          const cursorPos = editor.getPosition();
          const selection = editor.getSelection();
          if (
            pos && cursorPos && selection && selection.isEmpty() &&
            pos.lineNumber === cursorPos.lineNumber &&
            pos.column === cursorPos.column &&
            isTouchYInLineRow(touch, cursorPos.lineNumber)
          ) {
            isTapOnExistingCursor = true;
          }
        }

        // Only ever a candidate to open the menu at all if this tap is
        // one of the three recognized gestures below. A first tap that's
        // just building toward a possible double/triple-tap (the final
        // `else` branch) does NOT open anything yet - see the "single-tap
        // guard" comment further down for why.
        let shouldShowMenu = false;

        if (isTripleTap) {
          // Select the whole line that was tapped.
          e.preventDefault();
          const pos = posFromTouch(touch);
          if (pos) {
            const model = editor.getModel();
            editor.setSelection({
              startLineNumber: pos.lineNumber,
              startColumn: 1,
              endLineNumber: pos.lineNumber,
              endColumn: model.getLineMaxColumn(pos.lineNumber),
            });
            editor.focus();
            shouldShowMenu = true;
          }
          tapCount = 0;
          lastTapTime = 0;
          lastTapPos = null;
        } else if (isDoubleTap) {
          // Select the word under the tap.
          e.preventDefault();
          const pos = posFromTouch(touch);
          if (pos) {
            editor.setPosition(pos);
            editor.focus();
            const model = editor.getModel();
            const word = model.getWordAtPosition(pos);
            if (word) {
              editor.setSelection({
                startLineNumber: pos.lineNumber,
                startColumn: word.startColumn,
                endLineNumber: pos.lineNumber,
                endColumn: word.endColumn,
              });
            } else {
              // getWordAtPosition returns null on whitespace (whitespace
              // isn't a "word"). Select the contiguous run of whitespace
              // under the tap instead, so double-tapping a space still
              // produces a real (non-empty) selection and the menu shows
              // Cut/Copy/Paste rather than falling through to the
              // no-selection Select All/Paste menu.
              const lineContent = model.getLineContent(pos.lineNumber);
              const idx = pos.column - 1;
              if (idx >= 0 && idx < lineContent.length && /\s/.test(lineContent[idx])) {
                let start = idx;
                let end = idx + 1;
                while (start > 0 && /\s/.test(lineContent[start - 1])) start--;
                while (end < lineContent.length && /\s/.test(lineContent[end])) end++;
                editor.setSelection({
                  startLineNumber: pos.lineNumber,
                  startColumn: start + 1,
                  endLineNumber: pos.lineNumber,
                  endColumn: end + 1,
                });
              }
            }
            shouldShowMenu = true;
          }
          tapCount = 2;
          lastTapTime = now;
          lastTapPos = { x: touch.clientX, y: touch.clientY };
        } else if (isTapOnExistingCursor) {
          // No selection change - just open the menu as-is.
          e.preventDefault();
          editor.focus();
          shouldShowMenu = true;
          tapCount = 0;
          lastTapTime = 0;
          lastTapPos = null;
        } else {
          // Single-tap guard: this is either a genuine first tap (nothing
          // to show yet, wait and see if a second tap follows) or Monaco's
          // own native double-tap-to-select-word gesture just selected a
          // word during THIS touch, without our isDoubleTap check above
          // having caught it. We only trust nativeSelectionDuringTouch for
          // that - NOT a plain re-read of editor.getSelection() - because
          // a plain re-read can't tell "Monaco just selected this" apart
          // from "this is stale leftover selection state from before the
          // tap," which is exactly what caused Cut/Copy/Paste to
          // incorrectly reopen over nothing on a simple tap-away.
          tapCount = isCloseToLastTap ? tapCount + 1 : 1;
          lastTapTime = now;
          lastTapPos = { x: touch.clientX, y: touch.clientY };

          if (nativeSelectionDuringTouch) {
            const sel = editor.getSelection();
            if (sel && !sel.isEmpty()) {
              editor.focus();
              shouldShowMenu = true;
              tapCount = 0;
              lastTapTime = 0;
              lastTapPos = null;
            }
          }
        }

        if (shouldShowMenu) {
          // Re-read selection fresh right before deciding/building the
          // menu (rather than trusting isDoubleTap/isTripleTap/etc above),
          // so the menu content always matches reality even if Monaco
          // changed the selection asynchronously in between.
          showEditorTouchMenu(editor, touch.clientX, touch.clientY);
        }
      }

      touchStart = null;
    }, { passive: false });
  }

  // How long the closing animation runs, in ms. Kept in sync with the
  // .editor-touch-menu.is-closing transition duration in styles.css.
  const TOUCH_MENU_CLOSE_MS = 100;

  function closeEditorTouchMenu(menu) {
    if (!menu || menu.dataset.closing) return;
    menu.dataset.closing = "1";
    menu.classList.remove("is-open");
    menu.classList.add("is-closing");
    setTimeout(() => menu.remove(), TOUCH_MENU_CLOSE_MS);
  }

  // Selects the word/whitespace-run touching the cursor when nothing is
  // currently selected, for the "Select" menu item. Prefers the token
  // immediately to the LEFT of the cursor (matching "hello.world123|" ->
  // selecting "world123"); falls back to the token on the right if there's
  // nothing on the left (cursor at start of line, etc).
  function selectAdjacentToken(editor) {
    const pos = editor.getPosition();
    if (!pos) return;
    const model = editor.getModel();
    const lineContent = model.getLineContent(pos.lineNumber);
    const idx = pos.column - 1;

    const leftChar = idx > 0 ? lineContent[idx - 1] : "";
    const rightChar = idx < lineContent.length ? lineContent[idx] : "";

    const isSpace = (ch) => /\s/.test(ch);
    const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch);

    let probeCol = null;
    if (leftChar && isWordChar(leftChar)) {
      probeCol = idx; // 0-based index of the char left of cursor -> column idx+1's word
    } else if (rightChar && isWordChar(rightChar)) {
      probeCol = idx + 1;
    }

    if (probeCol !== null) {
      const word = model.getWordAtPosition({ lineNumber: pos.lineNumber, column: probeCol + 1 });
      if (word) {
        editor.setSelection({
          startLineNumber: pos.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: pos.lineNumber,
          endColumn: word.endColumn,
        });
        return;
      }
    }

    // Nothing word-like adjacent. If there's whitespace touching the
    // cursor, select that contiguous run (preferring the left side).
    const wsIdx = leftChar && isSpace(leftChar) ? idx - 1 : (rightChar && isSpace(rightChar) ? idx : -1);
    if (wsIdx >= 0) {
      let start = wsIdx;
      let end = wsIdx + 1;
      while (start > 0 && isSpace(lineContent[start - 1])) start--;
      while (end < lineContent.length && isSpace(lineContent[end])) end++;
      editor.setSelection({
        startLineNumber: pos.lineNumber,
        startColumn: start + 1,
        endLineNumber: pos.lineNumber,
        endColumn: end + 1,
      });
      return;
    }

    // Otherwise it's punctuation/symbol characters (quotes, semicolons,
    // brackets, operators, ...) touching the cursor - select the
    // contiguous run of punctuation/symbol chars (preferring the left
    // side), so e.g. `console.log("hello");|` -> Select grabs `");`.
    const isPunctChar = (ch) => !!ch && !isSpace(ch) && !isWordChar(ch);
    const punctIdx = leftChar && isPunctChar(leftChar) ? idx - 1 : (rightChar && isPunctChar(rightChar) ? idx : -1);
    if (punctIdx >= 0) {
      let start = punctIdx;
      let end = punctIdx + 1;
      while (start > 0 && isPunctChar(lineContent[start - 1])) start--;
      while (end < lineContent.length && isPunctChar(lineContent[end])) end++;
      editor.setSelection({
        startLineNumber: pos.lineNumber,
        startColumn: start + 1,
        endLineNumber: pos.lineNumber,
        endColumn: end + 1,
      });
    }
  }

  function showEditorTouchMenu(editor, x, y) {
    const existing = document.getElementById("editorTouchMenu");
    if (existing) existing.remove();

    const selection = editor.getSelection();
    const hasSelection = selection && !selection.isEmpty();

    const menu = document.createElement("div");
    menu.id = "editorTouchMenu";
    menu.className = "editor-touch-menu";

    const actions = hasSelection
      ? [
          ["Cut", () => execEditorAction(editor, "cut")],
          ["Copy", () => execEditorAction(editor, "copy")],
          ["Paste", () => execEditorAction(editor, "paste")],
        ]
      : [
          ["Select", () => {
            selectAdjacentToken(editor);
            editor.focus();
            showEditorTouchMenu(editor, x, y);
          }],
          ["Select All", () => {
            editor.trigger("touch", "editor.action.selectAll");
            editor.focus();
            showEditorTouchMenu(editor, x, y);
          }],
          ["Paste", () => execEditorAction(editor, "paste")],
        ];

    actions.forEach(([label, handler]) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.addEventListener("touchend", (e) => {
        e.preventDefault();
        handler();
        closeEditorTouchMenu(menu);
      });
      menu.appendChild(btn);
    });

    document.body.appendChild(menu);

    // Anchor the menu at a consistent Y above the cursor's own text row
    // (not the raw touch point), so it always lands in the same place
    // relative to the cursor regardless of exactly where within that row
    // the tap/double-tap/triple-tap landed. X still follows the tap so it
    // stays near the finger horizontally.
    const domNode = editor.getDomNode();
    const cursorPos = editor.getPosition();
    const rect = menu.getBoundingClientRect();
    let anchorY = y;
    if (domNode && cursorPos) {
      const domRect = domNode.getBoundingClientRect();
      const lineTop = domRect.top + editor.getTopForLineNumber(cursorPos.lineNumber) - editor.getScrollTop();
      anchorY = lineTop;
    }
    menu.style.left = Math.max(8, x - rect.width / 2) + "px";
    menu.style.top = Math.max(8, anchorY - rect.height - 12) + "px";

    // Animate in on the next frame (so the initial transform/opacity in
    // CSS is actually applied first, giving the transition something to
    // animate from).
    requestAnimationFrame(() => menu.classList.add("is-open"));

    const dismiss = (e) => {
      if (!menu.contains(e.target)) {
        closeEditorTouchMenu(menu);
        document.removeEventListener("touchstart", dismiss);
      }
    };
    setTimeout(() => document.addEventListener("touchstart", dismiss), 0);
  }

  async function execEditorAction(editor, kind) {
    const model = editor.getModel();
    const selection = editor.getSelection();
    const text = model.getValueInRange(selection);
    try {
      if (kind === "copy" || kind === "cut") {
        await navigator.clipboard.writeText(text);
        if (kind === "cut") {
          editor.executeEdits("touch-cut", [{ range: selection, text: "" }]);
        } else {
          // Copy doesn't touch the buffer, so the selection would
          // otherwise stay highlighted after the menu closes. Collapse it
          // to a cursor at the end of what was just copied, same as cut
          // and paste both naturally end up doing.
          editor.setPosition(selection.getEndPosition());
        }
      } else if (kind === "paste") {
        const clip = await navigator.clipboard.readText();
        editor.executeEdits("touch-paste", [{ range: selection, text: clip }]);
        // executeEdits leaves the newly-inserted text selected by default;
        // collapse to a plain cursor at the end of it instead.
        editor.setPosition(editor.getSelection().getEndPosition());
      }
    } catch (err) {
      console.warn("Clipboard action failed:", err);
    }
    editor.focus();
  }

  // ---------------------------------------------------------------
  // Monaco bootstrap
  // ---------------------------------------------------------------

  const MONACO_CDN = window.__MONACO_CDN || "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs";
  let bootAttempt = 0;
  let bootWatchdog = null;
  let bootDone = false;

  const log = window.__logBoot || function () {};
  log("app.js executing.");

  function showLoadError(message) {
    clearTimeout(bootWatchdog);
    loadingText.textContent = message;
    loadingRetryBtn.hidden = false;
    log("ERROR: " + message);
  }

  function startMonacoBoot(waitedMs) {
    waitedMs = waitedMs || 0;
    bootAttempt++;
    bootDone = false;
    loadingRetryBtn.hidden = true;
    loadingText.textContent = "Loading editor…";
    log("startMonacoBoot() attempt #" + bootAttempt);

    // The loader <script> is injected dynamically (its src depends on
    // browser detection), so it may not have finished by the time app.js
    // runs. Poll briefly before giving up, rather than failing immediately.
    if (typeof window.require !== "function" && !window.__monacoLoaderFailed) {
      if (waitedMs < 8000) {
        setTimeout(function () { startMonacoBoot(waitedMs + 100); }, 100);
        bootAttempt--; // this was a poll, not a real attempt
        return;
      }
    }

    if (window.__monacoLoaderFailed || typeof window.require !== "function") {
      log("window.require is " + typeof window.require + ", __monacoLoaderFailed=" + !!window.__monacoLoaderFailed);
      showLoadError("Couldn't reach the editor's CDN. Check your connection or content blockers, then retry.");
      return;
    }
    log("window.require is available, proceeding.");

    // Safety net: if editor.main never calls back (stalled request, iOS
    // Safari sometimes hangs instead of erroring), stop spinning forever.
    clearTimeout(bootWatchdog);
    bootWatchdog = setTimeout(function () {
      if (!bootDone) {
        showLoadError("The editor is taking too long to load. This can happen on some networks or with content blockers enabled in Safari.");
      }
    }, 12000);

    try {
      require.config({ paths: { vs: MONACO_CDN } });
      log("require.config set, calling require(['vs/editor/editor.main'])…");
      require(["vs/editor/editor.main"], function () {
        log("require() success callback fired.");
        onMonacoReady();
      }, function (err) {
        log("require() error callback fired: " + (err && err.message ? err.message : JSON.stringify(err)));
        showLoadError("Failed to load the editor. Check your connection or content blockers, then retry.");
      });
    } catch (e) {
      log("require() threw synchronously: " + e.message);
      showLoadError("Failed to load the editor. Check your connection or content blockers, then retry.");
    }
  }

  loadingRetryBtn.addEventListener("click", function () {
    if (bootAttempt >= 3) {
      // require.js caches failed module state; a full reload is the
      // most reliable way to retry after repeated failures.
      window.location.reload();
      return;
    }
    startMonacoBoot();
  });

  function onMonacoReady() {
    bootDone = true;
    clearTimeout(bootWatchdog);
    log("onMonacoReady() starting editor setup…");
    try {
      setupEditor();
      log("Editor setup complete. Hiding loading screen.");
    } catch (e) {
      log("ERROR during editor setup: " + e.message + (e.stack ? "\n" + e.stack : ""));
      showLoadError("Editor loaded but setup failed: " + e.message);
    }
  }

  function setupEditor() {
    monacoRef = monaco;

    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      allowJs: true,
      checkJs: false,
      lib: ["es2020", "dom"],
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs
    });

    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false
    });

    // Custom themes that mirror VS Code's actual *current* default token
    // colors. VS Code 1.113+ ships "Dark 2026" / "Light 2026" as the default
    // theme (replacing Dark+ / Dark Modern), with a notably different palette:
    // structural keywords (let/const/function) are red, flow keywords
    // (if/return/break) are purple, function calls are a lighter purple,
    // and strings are light blue instead of orange-brown.
    const DARK_2026_RULES = [
      { token: "comment", foreground: "8B949E" },
      { token: "keyword", foreground: "FF7B72" },
      { token: "keyword.control", foreground: "C586C0" },
      { token: "storage", foreground: "FF7B72" },
      { token: "storage.type", foreground: "FF7B72" },
      { token: "string", foreground: "A5D6FF" },
      { token: "number", foreground: "B5CEA8" },
      { token: "constant.language", foreground: "569CD6" },
      { token: "constant.numeric", foreground: "B5CEA8" },
      { token: "regexp", foreground: "A5D6FF" },
      { token: "delimiter", foreground: "D4D4D4" },
      { token: "delimiter.bracket", foreground: "D4D4D4" },
      { token: "operator", foreground: "D4D4D4" },
      { token: "identifier", foreground: "C9D1D9" },
      { token: "type", foreground: "4EC9B0" },
      { token: "type.identifier", foreground: "4EC9B0" },
      { token: "function", foreground: "D2A8FF" },
      { token: "variable", foreground: "FFA657" },
      { token: "variable.predefined", foreground: "569CD6" },
      { token: "annotation", foreground: "D2A8FF" }
    ];
    const LIGHT_2026_RULES = [
      { token: "comment", foreground: "6E7781" },
      { token: "keyword", foreground: "CF222E" },
      { token: "keyword.control", foreground: "8250DF" },
      { token: "storage", foreground: "CF222E" },
      { token: "storage.type", foreground: "CF222E" },
      { token: "string", foreground: "0A3069" },
      { token: "number", foreground: "098658" },
      { token: "constant.language", foreground: "0000FF" },
      { token: "constant.numeric", foreground: "098658" },
      { token: "regexp", foreground: "811F3F" },
      { token: "delimiter", foreground: "24292F" },
      { token: "delimiter.bracket", foreground: "24292F" },
      { token: "operator", foreground: "24292F" },
      { token: "identifier", foreground: "24292F" },
      { token: "type", foreground: "267F99" },
      { token: "type.identifier", foreground: "267F99" },
      { token: "function", foreground: "8250DF" },
      { token: "variable", foreground: "24292F" },
      { token: "variable.predefined", foreground: "0070C1" },
      { token: "annotation", foreground: "8250DF" }
    ];

    // Semantic token colors let Monaco color things like `console` (a
    // namespace/variable) and `log` (a method call) distinctly, the way
    // VS Code does using real type info instead of just grammar guesses.
    const DARK_2026_SEMANTIC = {
      "variable": "9CDCFE",
      "variable.readonly": "9CDCFE",
      "parameter": "9CDCFE",
      "property": "9CDCFE",
      "namespace": "4EC9B0",
      "function": "DCDCAA",
      "method": "DCDCAA",
      "class": "4EC9B0",
      "interface": "4EC9B0",
      "enum": "4EC9B0",
      "enumMember": "4FC1FF"
    };
    const LIGHT_2026_SEMANTIC = {
      "variable": "001080",
      "variable.readonly": "001080",
      "parameter": "001080",
      "property": "001080",
      "namespace": "267F99",
      "function": "795E26",
      "method": "795E26",
      "class": "267F99",
      "interface": "267F99",
      "enum": "267F99",
      "enumMember": "0070C1"
    };

    monaco.editor.defineTheme("dark-plus", {
      base: "vs-dark",
      inherit: true,
      rules: DARK_2026_RULES,
      colors: {
        "editor.background": "#121314",
        "editor.lineHighlightBackground": "#242526",
        "editor.lineHighlightBorder": "#00000000"
      },
      semanticTokenColors: DARK_2026_SEMANTIC
    });
    monaco.editor.defineTheme("light-plus", {
      base: "vs",
      inherit: true,
      rules: LIGHT_2026_RULES,
      colors: {
        "editor.lineHighlightBackground": "#F0F0F0",
        "editor.lineHighlightBorder": "#00000000"
      },
      semanticTokenColors: LIGHT_2026_SEMANTIC
    });
    monaco.editor.defineTheme("hc-black", {
      base: "hc-black",
      inherit: true,
      rules: DARK_2026_RULES,
      colors: {
        "editor.lineHighlightBackground": "#2A2D2E",
        "editor.lineHighlightBorder": "#00000000"
      },
      semanticTokenColors: DARK_2026_SEMANTIC
    });

    const loaded = loadFiles();
    files = loaded.files;
    activeFileId = loaded.activeFileId;
    const activeFile = getActiveFile();

    const model = getOrCreateModel(activeFile);

    editor = monaco.editor.create(document.getElementById("monacoContainer"), {
      model: model,
      theme: MONACO_THEME_MAP[settings.theme] || settings.theme,
      fontSize: settings.fontSize,
      fontFamily: "Consolas, 'Courier New', monospace",
      minimap: { enabled: settings.minimap },
      wordWrap: settings.wordWrap ? "on" : "off",
      automaticLayout: true,
      fixedOverflowWidgets: true,
      tabSize: 2,
      insertSpaces: true,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: "blink",
      cursorSmoothCaretAnimation: "off",
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: false, highlightActiveBracketPair: false },
      occurrencesHighlight: "off",
      selectionHighlight: false,
      suggestOnTriggerCharacters: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      parameterHints: { enabled: true },
      formatOnPaste: true,
      formatOnType: true,
      renderWhitespace: "selection",
      folding: true,
      matchBrackets: "never",
      // Touch support: lets a single-finger drag on iOS/iPadOS both move
      // the cursor and extend a selection, matching how touch text editing
      // works natively. mouseWheelZoom off so pinch/scroll gestures never
      // get reinterpreted as zoom on trackpads/touch.
      multiCursorModifier: "alt",
      mouseWheelZoomModifier: "ctrlCmd",
      dragAndDrop: true,
      selectionClipboard: false,
      autoClosingBrackets: "languageDefined",
      autoClosingQuotes: "languageDefined",
      autoClosingOvertype: "auto",
      autoClosingDelete: "auto",
      autoSurround: "languageDefined",
      tabCompletion: "on",
      snippetSuggestions: "inline",
      padding: { top: 12 },
      // Monaco has its own built-in right-click/long-press menu (Go to
      // Definition, Go to References, Command Palette, ...) that opens
      // independently of the native browser contextmenu event. On touch
      // devices we turn it off, since our custom double-tap Cut/Copy/Paste
      // menu is the only context menu we want there. On desktop we leave
      // it on, so right-click keeps working normally.
      contextmenu: isTouchDevice ? false : true
    });

    setupIOSTouchTextHandling(editor);

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyN, runCode);

    editor.onDidChangeModelContent(function () {
      saveCurrentEditorValue();
      clearTimeout(editor._saveDebounce);
      editor._saveDebounce = setTimeout(saveFiles, 400);
    });

    renderTabs();
    initWorker();

    loadingScreen.classList.add("hidden");
    setTimeout(function () { loadingScreen.style.display = "none"; }, 350);

    logSystem("Ready. Press Run or Ctrl + Alt + N to execute.");
  }

  startMonacoBoot();

  // Prevent iOS bounce/zoom weirdness on double-tap of toolbar buttons.
  document.addEventListener("dblclick", function (e) {
    if (e.target.closest(".icon-btn") || e.target.closest(".run-btn")) {
      e.preventDefault();
    }
  });

})();