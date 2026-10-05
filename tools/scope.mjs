// Which source files count as "in scope" for the translation coverage check.
// Scope = everything the Settings pages can render: the settings components
// plus every file reachable through imports from the settings routes.
import fs from "node:fs";
import path from "node:path";
import { reachable } from "./import-graph.mjs";

const PATTERNS = [
  /^apps\/web\/src\/components\/settings\//,
  /^apps\/web\/src\/routes\/settings[^/]*\.tsx$/,
  /^packages\/contracts\/src\/(settings|keybindings)\.ts$/,
  // Provider status checks, install/auth flows and driver metadata are shown on
  // Settings → Providers. Session adapters/runtimes only surface in chats.
  /^apps\/server\/src\/provider\/(?!.*(?:Adapter|SessionRuntime|\/acp\/))/,
  // Source control provider install hints / status on Settings → Source Control.
  /^apps\/server\/src\/sourceControl\//,
];
// Log calls never reach the UI.
const NON_UI_CTX = /^call:Effect\.log|^prop\?:_tag$/;

export function makeScope(srcRoot) {
  let files = new Set();
  if (srcRoot && fs.existsSync(path.join(srcRoot, "apps/web/src/routes"))) {
    const entries = fs
      .readdirSync(path.join(srcRoot, "apps/web/src/routes"))
      .filter((f) => /^settings.*\.tsx$/.test(f))
      .map((f) => `apps/web/src/routes/${f}`);
    files = new Set(reachable(srcRoot, entries).keys());
  }
  return (entry) =>
    entry.ctx.some((c) => !NON_UI_CTX.test(c)) &&
    entry.files.some((f) => files.has(f) || PATTERNS.some((re) => re.test(f)));
}
