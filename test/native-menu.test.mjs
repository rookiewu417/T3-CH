import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const { createT3zhNativeMenu } = createRequire(import.meta.url)("../runtime/native-menu.cjs");
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../runtime/dict.js", import.meta.url), "utf8"), sandbox);
const translate = createT3zhNativeMenu(sandbox.window.__T3ZH_DICT__);

test("native nested menus translate labels and counts while preserving actions and state", () => {
  const click = () => {};
  const items = [{ label: "Rename thread", click, enabled: false, id: "rename", accelerator: "F2" },
    { label: "Delete (3)", submenu: [{ label: "Copy Thread ID", checked: true, type: "checkbox" }, { label: "My custom editor" }] },
    { type: "separator" }, { label: "Open localhost:5173" }];
  const out = translate(items);
  assert.equal(out[0].label, "重命名会话");
  assert.equal(out[0].click, click);
  assert.equal(out[0].enabled, false);
  assert.equal(out[0].id, "rename");
  assert.equal(out[0].accelerator, "F2");
  assert.equal(out[1].label, "删除（3）");
  assert.equal(out[1].submenu[0].label, "复制会话 ID");
  assert.equal(out[1].submenu[0].checked, true);
  assert.equal(out[1].submenu[1].label, "My custom editor");
  assert.deepEqual(out[2], { type: "separator" });
  assert.equal(out[3].label, "打开 localhost:5173");
  assert.equal(items[0].label, "Rename thread");
});

test("built-in menu roles get Chinese labels without changing spelling suggestions", () => {
  const out = translate([{ role: "cut", enabled: false }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }, { label: "Copy" }], false);
  assert.deepEqual(out.map(x => x.label), ["剪切", "复制", "粘贴", "全选", "Copy"]);
  assert.equal(out[0].role, "cut");
  assert.equal(out[0].enabled, false);
});

test("app.asar patch is valid, idempotent, reversible and preserves unrelated bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3zh-native-"));
  try {
    const archive = path.join(dir, "app.asar");
    const source = '"use strict";\nfunction menus(input, normalizedItems, complete) {\nreturn [electron.Menu.buildFromTemplate([...input.template]), electron.Menu.buildFromTemplate(buildTemplate(normalizedItems, complete)), {label: "No suggestions"}, {label: "Copy Link"}, {label: "Copy Image"}];\n}\n';
    const untouched = Buffer.from("unrelated archive content");
    const entry = { offset: "0", size: Buffer.byteLength(source), integrity: { hash: "x".repeat(300) } };
    const header = { files: {} };
    let branch = header;
    for (const name of ["apps", "desktop", "dist-electron"]) branch = branch.files[name] = { files: {} };
    branch.files["main.cjs"] = entry;
    header.files["other.txt"] = { offset: String(entry.size), size: untouched.length };
    const json = JSON.stringify(header);
    const pre = Buffer.alloc(16);
    pre.writeUInt32LE(4, 0); pre.writeUInt32LE(Buffer.byteLength(json) + 8, 4);
    pre.writeUInt32LE(Buffer.byteLength(json) + 4, 8); pre.writeUInt32LE(Buffer.byteLength(json), 12);
    const original = Buffer.concat([pre, Buffer.from(json), Buffer.from(source), untouched]);
    fs.writeFileSync(archive, original);
    const patch = (...args) => execFileSync(process.execPath, ["tools/patch-asar.mjs", archive, ...args], { encoding: "utf8" });
    assert.match(patch("--check"), /needs patch/);
    assert.deepEqual(fs.readFileSync(archive), original);
    assert.match(patch(), /^patched:/);
    const bytes = fs.readFileSync(archive);
    const next = JSON.parse(bytes.subarray(16, 16 + Buffer.byteLength(json)).toString());
    const target = next.files.apps.files.desktop.files["dist-electron"].files["main.cjs"];
    const start = 16 + Buffer.byteLength(json);
    const script = bytes.subarray(start + Number(target.offset), start + Number(target.offset) + target.size).toString();
    new vm.Script(script);
    assert.ok(script.includes('label: "复制图片"'));
    assert.ok(script.includes('__t3zhNativeMenu([...input.template], false)'));
    assert.deepEqual(bytes.subarray(start, original.length), original.subarray(start));
    assert.match(patch(), /^up to date:/);
    assert.deepEqual(fs.readFileSync(archive), bytes);
    assert.match(patch("--remove"), /^unpatched:/);
    const restored = fs.readFileSync(archive);
    const restoredHeader = JSON.parse(restored.subarray(16, 16 + Buffer.byteLength(json)).toString());
    const restoredEntry = restoredHeader.files.apps.files.desktop.files["dist-electron"].files["main.cjs"];
    assert.equal(restoredEntry.offset, "0");
    assert.equal(restoredEntry.size, Buffer.byteLength(source));
    assert.equal(restoredEntry.t3zhOriginal, undefined);
    assert.deepEqual(restored.subarray(start, original.length), original.subarray(start));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
