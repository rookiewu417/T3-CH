// t3code 中文界面翻译器（运行时注入）
//
// Loaded by a <script> tag patched into the WSL runtime's client/index.html,
// after dict.js has defined window.__T3ZH_DICT__. It never touches T3's own
// bundles: it watches the DOM and swaps English UI text for Chinese, keeping
// the original so React's later updates and the on/off toggle stay correct.
(() => {
  "use strict";
  if (window.__t3zh) return;

  const DICT = window.__T3ZH_DICT__ || {};
  const STORAGE_DISABLED = "t3zh:disabled";
  const STORAGE_MISSING = "t3zh:missing";
  const TRANSLATED_ATTRS = ["title", "placeholder", "aria-placeholder", "alt", "data-placeholder"];

  // Regions holding user / agent / code content: never translate inside them.
  const SKIP_SELECTOR = [
    "script", "style", "noscript", "template", "pre", "code", "kbd", "samp", "textarea", "input",
    "[contenteditable='']", "[contenteditable='true']", "[contenteditable='plaintext-only']",
    ".chat-markdown", ".chat-markdown-shiki", "[data-user-message-body]",
    "[data-testid='composer-editor']", "[data-testid='file-diff']",
    ".xterm", ".monaco-editor", ".cm-editor", ".ProseMirror", ".tiptap",
    "[data-t3zh-skip]",
  ].join(",");
  // Form fields are skipped for their contents, but their placeholder/title are UI.
  const ATTR_SKIP_SELECTOR = SKIP_SELECTOR.split(",").filter((s) => s !== "input" && s !== "textarea").join(",");

  // ---------- dictionary ----------
  const literals = new Map();
  const cmdSegments = new Map(); // "cmd:Steer Queued" -> keybinding command label segment
  const templates = [];
  const normalize = (s) => s.replace(/\s+/g, " ").trim();

  for (const [en, zh] of Object.entries(DICT)) {
    if (typeof zh !== "string" || !zh) continue;
    const key = normalize(en);
    if (key.startsWith("cmd:")) {
      cmdSegments.set(key.slice(4), zh);
      continue;
    }
    if (!/\{\d+\}/.test(key)) {
      literals.set(key, zh);
      continue;
    }
    // "A{0}B{1}C" -> lits ["A","B","C"], order [0,1]. Matched with indexOf,
    // never with a backtracking regex (multi-placeholder regexes explode on long text).
    const lits = [];
    const order = [];
    let rest = key;
    for (let m = /\{(\d+)\}/.exec(rest); m; m = /\{(\d+)\}/.exec(rest)) {
      lits.push(rest.slice(0, m.index));
      order.push(Number(m[1]));
      rest = rest.slice(m.index + m[0].length);
    }
    lits.push(rest);
    const fixed = lits.join("");
    // A template needs enough fixed text, otherwise "{0} on {1}" would match
    // any sentence containing " on ".
    if (fixed.replace(/[^A-Za-z]/g, "").length < 5) continue;
    const needle = lits.reduce((x, y) => (y.length > x.length ? y : x), "");
    templates.push({ lits, order, needle, fixed: fixed.length, zh });
  }
  // Prefer the most specific templates (most fixed text) first.
  templates.sort((a, b) => b.fixed - a.fixed);

  function matchTemplate(t, s) {
    const { lits } = t;
    const first = lits[0];
    const last = lits[lits.length - 1];
    if (!s.startsWith(first) || !s.endsWith(last) || s.length <= first.length + last.length) return null;
    const end = s.length - last.length;
    const caps = [];
    let pos = first.length;
    for (let i = 1; i < lits.length - 1; i++) {
      const lit = lits[i];
      if (!lit) {
        caps.push(""); // adjacent placeholders: earlier one stays empty
        continue;
      }
      const at = s.indexOf(lit, pos + 1);
      if (at < 0 || at + lit.length > end) return null;
      caps.push(s.slice(pos, at));
      pos = at + lit.length;
    }
    if (pos >= end) return null;
    caps.push(s.slice(pos, end));
    return caps;
  }

  const cache = new Map();
  const CACHE_LIMIT = 20000;

  const looksLikeProse = (v) => !literals.has(v.trim()) && (v.match(/\b[a-z]{2,}\b/g) || []).length >= 3;

  // Keybinding command labels: "Thread: Steer Queued Message", "Model Picker: Jump: 3".
  function lookupCommandLabel(s) {
    if (!/^[A-Z0-9][\w ]*(?:: [A-Z0-9][\w ]*)+$/.test(s)) return null;
    const out = [];
    for (const seg of s.split(": ")) {
      const zh = cmdSegments.get(seg) ?? (/^\d+$/.test(seg) ? seg : null);
      if (zh === null) return null;
      out.push(zh);
    }
    return out.join("：");
  }

  function lookupCore(s) {
    const hit = literals.get(s);
    if (hit !== undefined) return hit;
    const cmd = lookupCommandLabel(s);
    if (cmd !== null) return cmd;
    if (s.length > 600) return null;
    for (const t of templates) {
      if (!s.includes(t.needle)) continue;
      const caps = matchTemplate(t, s);
      // Placeholders hold names, numbers, paths. If one swallowed an English
      // sentence ("Install {0}" vs "Install the update now or…"), it's not this template.
      if (!caps || caps.some(looksLikeProse)) continue;
      const values = [];
      t.order.forEach((idx, i) => {
        const v = caps[i];
        // Interpolated values are usually names/numbers; translate them only on an exact hit.
        values[idx] = literals.get(v.trim()) ?? v;
      });
      return t.zh.replace(/\{(\d+)\}/g, (_, i) => values[Number(i)] ?? "");
    }
    return null;
  }

  // Translate a whole string, preserving surrounding whitespace. Returns null if unknown.
  function translate(raw) {
    if (!raw || !/[A-Za-z]/.test(raw)) return null;
    const core = normalize(raw);
    if (!core) return null;
    let out = cache.get(core);
    if (out === undefined) {
      out = lookupCore(core);
      if (out === null) {
        // Separator-prefixed fragments: "· Timed out while…", "— Disabled".
        const sep = /^([·•—–|]\s*)(.+)$/.exec(core);
        if (sep) {
          const rest = lookupCore(sep[2]);
          if (rest !== null) out = sep[1] + rest;
        }
      }
      if (out === null) {
        // Trailing punctuation variants: "Name:" / "Loading..." / "Saving…"
        const m = /^(.*?)(\s*(?::|\.\.\.|…|\.)\s*)$/.exec(core);
        if (m && m[1]) {
          const base = lookupCore(m[1]);
          if (base !== null) {
            const p = m[2].trim();
            out = base + (p === ":" ? "：" : p === "." ? "。" : "…");
          }
        }
      }
      if (cache.size > CACHE_LIMIT) cache.clear();
      cache.set(core, out);
    }
    if (out === null) {
      noteMissing(core);
      return null;
    }
    const lead = /^\s*/.exec(raw)[0];
    const trail = /\s*$/.exec(raw)[0];
    return (lead ? " " : "") + out + (trail ? " " : "");
  }

  // ---------- missing-string log (to grow the dictionary) ----------
  const missing = new Set();
  let missingDirty = false;
  try {
    for (const s of JSON.parse(localStorage.getItem(STORAGE_MISSING) || "[]")) missing.add(s);
  } catch {}
  function noteMissing(s) {
    if (s.length > 200 || missing.size > 3000 || missing.has(s)) return;
    // Only things that look like English prose, not names / ids / numbers.
    if (!/^[A-Z][a-z]|[a-z]{3,} [a-z]{2,}/.test(s)) return;
    missing.add(s);
    if (!missingDirty) {
      missingDirty = true;
      setTimeout(() => {
        missingDirty = false;
        try {
          localStorage.setItem(STORAGE_MISSING, JSON.stringify([...missing]));
        } catch {}
      }, 5000);
    }
  }

  // ---------- DOM bookkeeping ----------
  // textNode -> { orig, shown }: lets us tell our own writes from React's.
  const textState = new WeakMap();
  // element -> { [attr]: { orig, shown } }
  const attrState = new WeakMap();

  function originalText(node) {
    const st = textState.get(node);
    if (st && node.data === st.shown) return st.orig;
    if (st) textState.delete(node);
    return node.data;
  }

  function setText(node, orig, shown) {
    if (shown === null || shown === orig) {
      if (textState.has(node)) {
        textState.delete(node);
        if (node.data !== orig) node.data = orig;
      }
      return;
    }
    textState.set(node, { orig, shown });
    if (node.data !== shown) node.data = shown;
  }

  const isSkipped = (el) => !el || el.closest(SKIP_SELECTOR) !== null;

  // An element whose children are only text nodes (≥2) is translated as one
  // string, so JSX like `Delete {n} files` (3 text nodes) matches a template.
  // If the whole doesn't match, each node is translated on its own. Both paths
  // write every node of the group, so they can never undo each other.
  function processTextGroup(el) {
    const nodes = [];
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 3) return false;
      nodes.push(c);
    }
    if (nodes.length < 2) return false;
    const origs = nodes.map(originalText);
    const zh = enabled ? translate(origs.join("")) : null;
    if (zh !== null) {
      nodes.forEach((n, i) => setText(n, origs[i], i === 0 ? zh : ""));
    } else {
      nodes.forEach((n, i) => setText(n, origs[i], enabled ? translate(origs[i]) : null));
    }
    return true;
  }

  function processTextNode(node) {
    const parent = node.parentElement;
    if (!parent || isSkipped(parent)) return;
    if (processTextGroup(parent)) return;
    const orig = originalText(node);
    setText(node, orig, enabled ? translate(orig) : null);
  }

  function processAttrs(el) {
    if (el.closest(ATTR_SKIP_SELECTOR) !== null) return;
    for (const name of TRANSLATED_ATTRS) {
      const cur = el.getAttribute(name);
      if (cur === null) continue;
      let states = attrState.get(el);
      const st = states && states[name];
      const orig = st && cur === st.shown ? st.orig : cur;
      const zh = enabled ? translate(orig) : null;
      if (zh === null) {
        if (st) {
          delete states[name];
          if (cur !== orig) el.setAttribute(name, orig);
        }
        continue;
      }
      if (!states) attrState.set(el, (states = {}));
      states[name] = { orig, shown: zh };
      if (cur !== zh) el.setAttribute(name, zh);
    }
  }

  function processTree(root) {
    if (root.nodeType === 3) return processTextNode(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      processAttrs(root);
      if (isSkipped(root)) return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          processAttrs(n);
          return n.matches(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const texts = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
    for (const t of texts) processTextNode(t);
  }

  // ---------- document title ----------
  let titleOrig = null;
  let titleShown = null;
  function processTitle() {
    const cur = document.title;
    const orig = titleShown !== null && cur === titleShown ? titleOrig : cur;
    const zh = enabled ? translate(orig) : null;
    titleOrig = orig;
    titleShown = zh;
    const want = zh ?? orig;
    if (cur !== want) document.title = want;
  }

  // ---------- observer ----------
  let enabled = localStorage.getItem(STORAGE_DISABLED) !== "1";
  const isTitle = (n) => n && n.nodeName === "TITLE";

  // Circuit breaker: if our own writes ever keep re-triggering the observer
  // (a feedback loop with some component), back off instead of freezing T3.
  let burst = 0;
  let burstTimer = 0;
  const loops = [];
  const describe = (n) => {
    const el = n.nodeType === 1 ? n : n.parentElement;
    return el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} "${(n.textContent || "").slice(0, 60)}"` : String(n);
  };

  const observer = new MutationObserver((records) => {
    if (!burstTimer) burstTimer = setTimeout(() => ((burst = 0), (burstTimer = 0)), 0);
    if (++burst > 50) {
      loops.push(records.slice(0, 5).map((r) => `${r.type} ${r.attributeName || ""} ${describe(r.target)}`));
      if (loops.length > 20) loops.shift();
      console.warn("[t3zh] mutation feedback loop detected; pausing for 2s", loops[loops.length - 1]);
      observer.disconnect();
      setTimeout(() => {
        burst = 0;
        observe();
        rescan();
      }, 2000);
      return;
    }
    const trees = new Set();
    const attrs = new Set();
    let title = false;
    for (const r of records) {
      const t = r.target;
      if (isTitle(t) || isTitle(t.parentNode)) {
        title = true;
        continue;
      }
      if (r.type === "attributes") {
        if (TRANSLATED_ATTRS.includes(r.attributeName)) attrs.add(t);
        else trees.add(t); // contenteditable changes can move a region in or out of skip
      } else if (r.type === "characterData") {
        trees.add(t);
      } else {
        r.addedNodes.forEach((n) => trees.add(n));
        // Removing a node from a mixed text group changes how the rest should read.
        if (r.removedNodes.length && t.nodeType === 1 && t.firstChild && t.firstChild.nodeType === 3) {
          trees.add(t.firstChild);
        }
      }
    }
    for (const n of trees) if (n.isConnected) processTree(n);
    for (const el of attrs) if (el.isConnected && !trees.has(el)) processAttrs(el);
    if (title) processTitle();
  });

  function observe() {
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATED_ATTRS, "contenteditable"],
    });
  }

  function rescan() {
    processTree(document.documentElement || document);
    processTitle();
  }

  function setEnabled(on) {
    enabled = on;
    try {
      localStorage.setItem(STORAGE_DISABLED, on ? "0" : "1");
    } catch {}
    cache.clear();
    observer.disconnect();
    rescan();
    observe();
  }

  // Ctrl+Alt+L toggles Chinese / English.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.code === "KeyL") {
        e.preventDefault();
        e.stopPropagation();
        setEnabled(!enabled);
      }
    },
    true,
  );

  window.__t3zh = {
    version: DICT.__version__ || "dev",
    get enabled() {
      return enabled;
    },
    toggle: () => setEnabled(!enabled),
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    translate,
    missing: () => [...missing],
    clearMissing: () => {
      missing.clear();
      localStorage.removeItem(STORAGE_MISSING);
    },
    stats: () => ({ literals: literals.size, templates: templates.length }),
    loops: () => loops,
  };

  observe();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", rescan, { once: true });
  } else {
    rescan();
  }
})();
