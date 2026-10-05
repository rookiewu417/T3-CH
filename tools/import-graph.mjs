// Files reachable through imports from a set of entry files (apps/web only).
import fs from "node:fs";
import path from "node:path";

const EXTS = [".tsx", ".ts", "/index.tsx", "/index.ts"];

export function reachable(srcRoot, entries, { maxDepth = Infinity, exclude = [] } = {}) {
  const webSrc = path.join(srcRoot, "apps/web/src");
  const resolve = (from, spec) => {
    let base;
    if (spec.startsWith("~/")) base = path.join(webSrc, spec.slice(2));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
    else return null;
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
    for (const e of EXTS) if (fs.existsSync(base + e)) return base + e;
    return null;
  };
  const seen = new Map();
  const queue = entries.map((f) => [path.join(srcRoot, f), 0]);
  while (queue.length) {
    const [file, depth] = queue.shift();
    if (seen.has(file)) continue;
    seen.set(file, depth);
    if (depth >= maxDepth) continue;
    const code = fs.readFileSync(file, "utf8");
    for (const m of code.matchAll(/(?:import|export)[^'"]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const dep = resolve(file, m[1] ?? m[2]);
      if (dep && !exclude.some((re) => re.test(path.relative(srcRoot, dep)))) queue.push([dep, depth + 1]);
    }
  }
  return new Map([...seen].map(([f, d]) => [path.relative(srcRoot, f), d]));
}
