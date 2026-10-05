#!/usr/bin/env node
// Report in-scope extracted strings that have no translation yet.
//   node tools/check-dict.mjs <extracted.json> [--src t3code-src] [--all] [--json out.json]
import fs from "node:fs";
import path from "node:path";
import { makeScope } from "./scope.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);
const extracted = JSON.parse(fs.readFileSync(args[0] ?? "extracted/latest.json", "utf8"));
const all = args.includes("--all");
const srcRoot = args.includes("--src") ? args[args.indexOf("--src") + 1] : null;
const inScope = makeScope(srcRoot);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const dict = {};
const dir = path.join(root, "dict/zh-CN");
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  Object.assign(dict, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

// Strings deliberately left in English (product names, key names, CSS, examples).
const keepEn = new Set(JSON.parse(fs.readFileSync(path.join(root, "dict/keep-en.json"), "utf8")));
const wanted = extracted.filter((e) => (all || inScope(e)) && !keepEn.has(e.text));
const todo = wanted.filter((e) => !(e.text in dict));
console.log(`in scope: ${wanted.length}, translated: ${wanted.length - todo.length}, missing: ${todo.length}`);
if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(todo, null, 1) + "\n");
  console.log(`missing list -> ${jsonOut}`);
} else {
  for (const e of todo.slice(0, 50)) console.log(`  ${JSON.stringify(e.text)}  (${e.files[0]})`);
  if (todo.length > 50) console.log(`  … ${todo.length - 50} more`);
}
