#!/usr/bin/env node
// Inject the translator into the Windows desktop client.
//
// The desktop window loads t3code://app/ from server.asar's
// apps/server/dist/client, not from the WSL server, so index.html inside the
// asar is patched: a new index.html (with the dictionary and engine inlined;
// the desktop CSP allows inline scripts) is appended to the end of the archive
// and the header entry is re-pointed at it. The header keeps its exact byte
// length (the entry's integrity field is dropped and the JSON is space-padded),
// so no other offset moves and the original bytes stay in place.
//
//   node tools/patch-asar.mjs [server.asar] [--remove] [--check]
// Without a path, every /mnt/c/Users/*/AppData/Local/Programs/t3code install is used.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const remove = args.includes("--remove");
const checkOnly = args.includes("--check");
const explicit = args.filter((a) => !a.startsWith("--"));

const BEGIN = "<!--t3zh-begin-->";
const END = "<!--t3zh-end-->";
const INDEX_PATH = ["apps", "server", "dist", "client", "index.html"];
const MAIN_PATH = ["apps", "desktop", "dist-electron", "main.cjs"];

function findInstalls() {
  const users = "/mnt/c/Users";
  if (!fs.existsSync(users)) return [];
  return fs
    .readdirSync(users)
    .flatMap((u) => ["server.asar", "app.asar"].map((name) => path.join(users, u, "AppData/Local/Programs/t3code/resources", name)))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

function readHeader(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // Pickle(uint32 headerPickleSize) then Pickle(string headerJson).
  const headerPickleSize = head.readUInt32LE(4);
  const jsonLength = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonLength);
  fs.readSync(fd, json, 0, jsonLength, 16);
  return { header: JSON.parse(json.toString("utf8")), jsonLength, dataStart: 8 + headerPickleSize };
}

function entryFor(header, entryPath) {
  let node = header;
  for (const part of entryPath) {
    node = node.files?.[part];
    if (!node) throw new Error(`asar has no ${entryPath.join("/")}`);
  }
  if (node.unpacked) throw new Error("target entry is unpacked; unsupported");
  return node;
}

function injection() {
  const safe = (s) => s.replace(/<\/(script)/gi, "<\\/$1");
  const dict = fs.readFileSync(path.join(root, "runtime/dict.js"), "utf8");
  const engine = fs.readFileSync(path.join(root, "runtime/t3zh.js"), "utf8");
  return `${BEGIN}<script>${safe(dict)}</script><script>${safe(engine)}</script>${END}`;
}

function patchNativeMenu(source) {
  const replacements = [
    ["electron.Menu.buildFromTemplate([...input.template])", "electron.Menu.buildFromTemplate(__t3zhNativeMenu([...input.template], false))"],
    ["electron.Menu.buildFromTemplate(buildTemplate(normalizedItems, complete))", "electron.Menu.buildFromTemplate(__t3zhNativeMenu(buildTemplate(normalizedItems, complete)))"],
    ['label: "No suggestions"', 'label: "无拼写建议"'],
    ['label: "Copy Link"', 'label: "复制链接"'],
    ['label: "Copy Image"', 'label: "复制图片"'],
  ];
  // Refuse an unfamiliar bundle before writing any bytes to the archive.
  for (const [from, to] of replacements) {
    if (source.split(from).length !== 2) throw new Error(`unsupported native menu bundle: expected one ${from}`);
    source = source.replace(from, to);
  }
  const dictSource = fs.readFileSync(path.join(root, "runtime/dict.js"), "utf8");
  const dict = JSON.parse(dictSource.slice(dictSource.indexOf(" = ") + 3).trim().replace(/;$/, ""));
  const helper = fs.readFileSync(path.join(root, "runtime/native-menu.cjs"), "utf8").replace("module.exports = { createT3zhNativeMenu };", "");
  // Initialize at module scope, never at a nested function's strict directive.
  const prelude = `${helper}\nconst __t3zhNativeMenu = createT3zhNativeMenu(${JSON.stringify(dict)});\n`;
  const directive = /^(\s*["']use strict["'];)/;
  return directive.test(source) ? source.replace(directive, (match) => `${match}\n${prelude}`) : prelude + source;
}

function t3Running() {
  try {
    return execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq T3 Code (Alpha).exe", "/NH"], {
      encoding: "utf8",
    }).includes("T3 Code");
  } catch {
    return true; // unknown: assume running and never truncate
  }
}

function patch(asarPath) {
  const fd = fs.openSync(asarPath, "r+");
  try {
    const { header, jsonLength, dataStart } = readHeader(fd);
    const native = path.basename(asarPath) === "app.asar";
    const entry = entryFor(header, native ? MAIN_PATH : INDEX_PATH);
    const read = (offset, size) => {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, dataStart + Number(offset));
      return buf.toString("utf8");
    };
    // Where T3's own index.html lives; recorded on first patch.
    const orig = entry.t3zhOriginal ?? { offset: entry.offset, size: entry.size };
    const originalHtml = read(orig.offset, orig.size);
    const currentHtml = read(entry.offset, entry.size);
    const fileSize = fs.fstatSync(fd).size;
    const ourRegionAtEnd =
      entry.offset !== orig.offset && dataStart + Number(entry.offset) + entry.size === fileSize;

    let next = null; // { offset, size, bytes? }
    if (remove) {
      if (!entry.t3zhOriginal) return "not patched";
      next = { offset: orig.offset, size: orig.size };
    } else {
      const block = native ? null : injection();
      // Classic inline scripts run before React's deferred module script.
      const html = native ? patchNativeMenu(originalHtml) : /<meta charset[^>]*>/i.test(originalHtml)
        ? originalHtml.replace(/(<meta charset[^>]*>)/i, `$1${block}`)
        : originalHtml.replace(/<head>/i, `<head>${block}`);
      if (entry.t3zhOriginal && html === currentHtml) return "up to date";
      next = { bytes: Buffer.from(html, "utf8") };
    }
    if (checkOnly) return "needs patch";

    // Reuse our previous appended copy's space only while T3 is closed: a
    // running T3 caches the old header and may re-read those bytes on reload.
    const canTruncate = ourRegionAtEnd && !t3Running();
    const end = canTruncate ? dataStart + Number(entry.offset) : fileSize;
    if (next.bytes) {
      fs.writeSync(fd, next.bytes, 0, next.bytes.length, end);
      entry.offset = String(end - dataStart);
      entry.size = next.bytes.length;
      entry.t3zhOriginal = orig;
    } else {
      entry.offset = next.offset;
      entry.size = next.size;
      delete entry.t3zhOriginal;
    }
    delete entry.integrity;
    let json = JSON.stringify(header);
    const len = Buffer.byteLength(json);
    if (len > jsonLength) throw new Error("patched asar header would grow");
    json += " ".repeat(jsonLength - len);
    fs.writeSync(fd, Buffer.from(json, "utf8"), 0, jsonLength, 16);
    if (canTruncate) fs.ftruncateSync(fd, next.bytes ? end + next.bytes.length : end);
    return remove ? "unpatched" : "patched";
  } finally {
    fs.closeSync(fd);
  }
}

const targets = explicit.length ? explicit : findInstalls();
if (!targets.length) {
  console.log("no Windows t3code install found");
  process.exit(0);
}
let failed = false;
for (const t of targets) {
  try {
    console.log(`${patch(t)}: ${t}`);
  } catch (e) {
    failed = true;
    console.error(`failed: ${t}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
