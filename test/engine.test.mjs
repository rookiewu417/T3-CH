// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const engine = fs.readFileSync(new URL("../runtime/t3zh.js", import.meta.url), "utf8");

function setup(dict, body = "") {
  const dom = new JSDOM(`<!doctype html><html><head><title>Settings</title></head><body>${body}</body></html>`, {
    runScripts: "outside-only",
    url: "http://localhost/",
  });
  const { window } = dom;
  window.__T3ZH_DICT__ = dict;
  window.eval(engine);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { window, document: window.document, flush };
}

const DICT = {
  Settings: "设置",
  General: "通用",
  "Test connection": "测试连接",
  "Archived {0} · Created {1}": "归档于 {0} · 创建于 {1}",
  "Delete {0} files": "删除 {0} 个文件",
  "{0} on {1}": "{1} 上的 {0}",
  "{0} model{1} {2} {3}": "{0} 个模型{2}{3}",
  "Search settings": "搜索设置",
  Loading: "加载",
};

test("translates text, attributes and title on load", async () => {
  const { document, flush } = setup(DICT, `<h1> Settings </h1><input placeholder="Search settings"><span title="General">x</span>`);
  await flush();
  assert.equal(document.querySelector("h1").textContent, " 设置 ");
  assert.equal(document.querySelector("input").placeholder, "搜索设置");
  assert.equal(document.querySelector("span").title, "通用");
  assert.equal(document.title, "设置");
});

test("templates and split JSX text groups", async () => {
  const { document, flush } = setup(DICT, `<p>Archived Mon · Created Tue</p><p id="g"></p>`);
  const g = document.getElementById("g");
  for (const t of ["Delete ", "3", " files"]) g.appendChild(document.createTextNode(t));
  await flush();
  assert.equal(document.querySelector("p").textContent, "归档于 Mon · 创建于 Tue");
  assert.equal(g.textContent, "删除 3 个文件");
  // React updates the middle node in place.
  g.childNodes[1].data = "7";
  await flush();
  assert.equal(g.textContent, "删除 7 个文件");
});

test("short-template guard: '{0} on {1}' is never applied", async () => {
  const { document, flush } = setup(DICT, `<p>Turn on notifications</p>`);
  await flush();
  assert.equal(document.querySelector("p").textContent, "Turn on notifications");
});

test("skips chat markdown, code and editors", async () => {
  const { document, flush } = setup(
    DICT,
    `<div class="chat-markdown"><p>Settings</p></div><code>General</code><div contenteditable="true">Settings</div><div data-user-message-body>General</div>`,
  );
  await flush();
  assert.equal(document.querySelector(".chat-markdown p").textContent, "Settings");
  assert.equal(document.querySelector("code").textContent, "General");
  assert.equal(document.querySelector("[contenteditable]").textContent, "Settings");
  assert.equal(document.querySelector("[data-user-message-body]").textContent, "General");
});

test("React-style replacement of a translated node is retranslated", async () => {
  const { document, flush } = setup(DICT, `<button>Settings</button>`);
  await flush();
  const b = document.querySelector("button");
  assert.equal(b.textContent, "设置");
  b.firstChild.data = "General"; // React writes a new English value
  await flush();
  assert.equal(b.textContent, "通用");
  b.firstChild.data = "Unknown thing";
  await flush();
  assert.equal(b.textContent, "Unknown thing");
});

test("toggle restores English and back", async () => {
  const { window, document, flush } = setup(DICT, `<h1>Settings</h1><input placeholder="Search settings">`);
  await flush();
  window.__t3zh.disable();
  await flush();
  assert.equal(document.querySelector("h1").textContent, "Settings");
  assert.equal(document.querySelector("input").placeholder, "Search settings");
  window.__t3zh.enable();
  await flush();
  assert.equal(document.querySelector("h1").textContent, "设置");
});

test("trailing punctuation fallback", async () => {
  const { window } = setup(DICT);
  assert.equal(window.__t3zh.translate("Loading..."), "加载…");
  assert.equal(window.__t3zh.translate("General:"), "通用：");
});

test("no mutation feedback loop", async () => {
  const { window, document, flush } = setup(DICT, `<div id="r"></div>`);
  let records = 0;
  new window.MutationObserver((rs) => (records += rs.length)).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  const r = document.getElementById("r");
  for (let i = 0; i < 50; i++) {
    const p = document.createElement("p");
    p.title = "General";
    p.append("Delete ", String(i), " files");
    r.appendChild(p);
  }
  for (let i = 0; i < 5; i++) await flush();
  const settled = records;
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(records, settled, "observer keeps firing");
});

test("long text with template needles stays fast", async () => {
  const { window } = setup(DICT);
  const long = ("x model y on z ".repeat(400)).trim();
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) window.__t3zh.translate(long + i);
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0}ms`);
});

test("real dictionary loads and all templates compile", () => {
  const src = fs.readFileSync(new URL("../runtime/dict.js", import.meta.url), "utf8");
  const dom = new JSDOM(`<!doctype html><body></body>`, { runScripts: "outside-only", url: "http://localhost/" });
  dom.window.eval(src);
  dom.window.eval(engine);
  const s = dom.window.__t3zh.stats();
  assert.ok(s.literals > 1500, JSON.stringify(s));
  assert.equal(dom.window.__t3zh.translate("Default model for new threads. Projects can override it."), "新会话的默认模型。各项目可以覆盖此设置。");
  assert.equal(dom.window.__t3zh.translate("Average CPU 12%, peak CPU 40%"), "平均 CPU 12%，峰值 CPU 40%");
});

test("template placeholder must not swallow an English sentence", async () => {
  const { window } = setup({ "Install {0}": "安装 {0}" });
  assert.equal(window.__t3zh.translate("Install Codex"), "安装 Codex");
  assert.equal(window.__t3zh.translate("Install the update now or review provider settings."), null);
});

test("partially translatable text group does not ping-pong", async () => {
  const { window, document, flush } = setup({ Unavailable: "不可用" });
  const span = document.createElement("span");
  span.append("Unavailable", " · Timed out while checking Codex app-server provider status.");
  document.body.appendChild(span);
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(window.__t3zh.loops().length, 0);
  assert.equal(span.textContent, "不可用 · Timed out while checking Codex app-server provider status.");
  // React then updates the headline.
  span.firstChild.data = "Unavailable";
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(window.__t3zh.loops().length, 0);
  assert.equal(span.firstChild.data, "不可用");
});

test("separator-prefixed fragments", () => {
  const { window } = setup({ "Timed out.": "超时。" });
  assert.equal(window.__t3zh.translate(" · Timed out."), " · 超时。");
});

test("keybinding command labels are translated per segment", () => {
  const { window } = setup({ "cmd:Thread": "会话", "cmd:Jump": "跳转", "cmd:Next": "下一个", Next: "下一步" });
  assert.equal(window.__t3zh.translate("Thread: Jump: 3"), "会话：跳转：3");
  assert.equal(window.__t3zh.translate("Thread: Next"), "会话：下一个");
  assert.equal(window.__t3zh.translate("Next"), "下一步");
  assert.equal(window.__t3zh.translate("Thread: Unknown"), null);
});
