#!/usr/bin/env node
// Extract user-visible UI strings from a t3code source checkout.
//
// Usage: node tools/extract-strings.mjs <t3code-src-dir> [out.json]
//
// Output entries:
//   { text, kind: "literal" | "template", ctx, files }
// "template" entries use {0}, {1}… placeholders for interpolated values,
// matching the runtime translator's pattern syntax.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const srcRoot = process.argv[2];
const outFile = process.argv[3] ?? "extracted/strings.json";
if (!srcRoot) {
  console.error("usage: extract-strings.mjs <t3code-src-dir> [out.json]");
  process.exit(1);
}

const SCAN_DIRS = ["apps/web/src", "packages/contracts/src", "apps/server/src/provider", "apps/server/src/sourceControl"];
const SKIP_FILE = /\.(test|spec|stories|bench)\.[cm]?tsx?$|\.d\.ts$|\/__tests__\//;

// JSX attributes whose string values are rendered to the user.
const UI_ATTRS = new Set([
  "aria-label", "aria-description", "aria-placeholder", "aria-valuetext", "alt", "title",
  "placeholder", "label", "description", "tooltip", "heading", "subtitle", "emptyText",
  "emptyMessage", "message", "text", "hint", "helperText", "caption", "confirmLabel",
  "cancelLabel", "actionLabel", "ariaLabel", "name", "children", "content", "summary",
  "detail", "body", "header", "footer", "badge", "prefix", "suffix", "status",
]);
// Object property names whose string values are usually rendered.
const UI_PROPS = new Set([
  ...UI_ATTRS, "title", "label", "description", "placeholder", "message", "text", "hint",
  "shortLabel", "longLabel", "displayName", "groupLabel", "sectionLabel", "emptyLabel",
  "tooltip", "confirmText", "cancelText", "actionText", "subtitle", "details", "reason",
  "error", "warning", "info", "successMessage", "errorMessage", "loadingMessage",
]);
// Attributes / props whose values are never shown.
const NON_UI_ATTRS = new Set([
  "className", "class", "style", "key", "id", "href", "src", "type", "variant", "size",
  "side", "align", "role", "fill", "stroke", "d", "viewBox", "xmlns", "target", "rel",
  "htmlFor", "autoComplete", "inputMode", "method", "mode", "orientation", "data-slot",
  "data-testid", "sideOffset", "render", "as", "dir", "lang", "accept", "pattern",
]);
const NON_UI_CALLEES = /^(cn|clsx|cva|twMerge|classNames|require|import|useQuery|queryKey|Symbol|Effect\.fn|Effect\.withSpan|Schema\.\w+|Context\.\w+|Data\.\w+|Layer\.\w+|console\.\w+|logger\.\w+|log\w*|addEventListener|removeEventListener|querySelector\w*|getElementById|matchMedia|localStorage\.\w+|sessionStorage\.\w+|\w+\.getItem|\w+\.setItem|\w+\.removeItem|new URL|fetch|navigate|startsWith|endsWith|includes|split|join|replace\w*|indexOf|test|match|RegExp|Intl\.\w+|toLocale\w+|span|annotate\w*)$/;

const hasLetter = (s) => /[A-Za-z]/.test(s);
// Values that are styling, identifiers or other machine tokens even in "UI" positions.
function isJunk(s) {
  const t = s.trim();
  if (/^(rgba?|hsla?|oklch|oklab|color-mix|polygon|calc|var|url|linear-gradient|radial-gradient|cubic-bezier|translate\w*|scale|rotate)\(/.test(t)) return true;
  if (/^[a-z][a-zA-Z0-9]*$/.test(t) && /[A-Z]/.test(t)) return true; // camelCase id
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(t)) return true; // kebab/snake id
  if (/(^|\s)(?:[a-z]+:)*-?[a-z]+-[\w./[\]%&_:-]+/.test(t) && !/[A-Z]/.test(t[0]) && /[/[\]&]|-\d/.test(t)) return true; // tailwind
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return true;
  if (/^[{[]\s*"/.test(t) || /\(\?[:=!]|\\[sdwb]/.test(t)) return true; // JSON fixtures, regex sources
  if (/^\[[A-Za-z][^\]]*\]$/.test(t)) return true; // "[terminal {0}]" style agent-facing markers
  if (/^\d+(\.\d+)?(px|rem|em|ms|s|%)?$/.test(t)) return true;
  return false;
}
const norm = (s) => s.replace(/\s+/g, " ").trim();

// Heuristic: does a bare string literal look like prose a person would read?
function looksLikeProse(s) {
  if (!hasLetter(s) || s.length < 2 || s.length > 400) return false;
  if (/^[a-z0-9_.:/@#-]+$/.test(s)) return false; // identifiers, keys, paths, kebab tokens
  if (/^[A-Z0-9_]+$/.test(s)) return false; // CONSTANTS
  if (/^[a-z]+[A-Z]\w*$/.test(s)) return false; // camelCase
  if (/^(https?:|mailto:|file:|data:|\.{0,2}\/|~\/|[A-Za-z]:\\)/.test(s)) return false;
  if (/^[\w-]+\.(tsx?|jsx?|json|md|css|svg|png|html|sh)$/.test(s)) return false;
  if (/[{}<>;=]|=>|\$\{/.test(s)) return false; // code-ish
  if (/^(?:[a-z-]+:)?[a-z0-9-[\]/.:%#()]+(?:\s+(?:[a-z-]+:)?[a-z0-9-[\]/.:%#()]+)+$/.test(s)) {
    return false; // tailwind / css class lists
  }
  if (/^[A-Z][A-Za-z]*(?:[A-Z][a-z]+)+$/.test(s)) return false; // PascalCase ids
  if (/^[A-Z][a-z]+(?:\s|$)/.test(s)) return true; // "Open settings", "Settings"
  if (/\s/.test(s) && /[a-z]{2,}/.test(s) && /[.!?…:)]$|^[A-Z]/.test(s)) return true;
  return false;
}

const results = new Map(); // key -> entry
function add(text, kind, ctx, file) {
  const t = norm(text);
  if (!t || !hasLetter(t) || isJunk(t)) return;
  const key = `${kind}\u0000${t}`;
  let e = results.get(key);
  if (!e) {
    e = { text: t, kind, ctx: new Set(), files: new Set() };
    results.set(key, e);
  }
  e.ctx.add(ctx);
  e.files.add(file);
}

function calleeName(call) {
  const ex = call.expression;
  if (ts.isIdentifier(ex)) return ex.text;
  if (ts.isPropertyAccessExpression(ex)) {
    const left = ts.isIdentifier(ex.expression) ? ex.expression.text : "?";
    return `${left}.${ex.name.text}`;
  }
  return "";
}

// Describe where a string literal sits, or return null if it is definitely not UI text.
function classify(node) {
  let child = node;
  let p = node.parent;
  // Climb through wrappers that don't change meaning.
  while (
    p &&
    (ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression?.(p) ||
      ts.isConditionalExpression(p) ||
      (ts.isBinaryExpression(p) &&
        [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(
          p.operatorToken.kind,
        )) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isJsxExpression(p))
  ) {
    if (ts.isConditionalExpression(p) && p.condition === child) return null;
    if (ts.isJsxExpression(p) && ts.isJsxElement(p.parent)) return "jsx-child";
    if (ts.isJsxExpression(p) && ts.isJsxFragment(p.parent)) return "jsx-child";
    child = p;
    p = p.parent;
  }
  if (!p) return null;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode?.(p)) return null;
  if (ts.isLiteralTypeNode(p) || ts.isExternalModuleReference(p)) return null;
  if (ts.isCaseClause(p)) return null;
  if (ts.isElementAccessExpression(p)) return null;
  if (ts.isPropertyAssignment(p) && p.name === child) return null;
  if (
    ts.isBinaryExpression(p) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.InKeyword,
    ].includes(p.operatorToken.kind)
  ) {
    return null;
  }
  if (ts.isJsxAttribute(p)) {
    const name = p.name.getText();
    if (NON_UI_ATTRS.has(name) || name.startsWith("data-") || name.startsWith("on")) return null;
    return UI_ATTRS.has(name) ? `attr:${name}` : `attr?:${name}`;
  }
  if (ts.isPropertyAssignment(p)) {
    const name = p.name.getText().replace(/^["']|["']$/g, "");
    if (NON_UI_ATTRS.has(name)) return null;
    return UI_PROPS.has(name) ? `prop:${name}` : `prop?:${name}`;
  }
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const name = ts.isCallExpression(p) ? calleeName(p) : `new ${p.expression.getText()}`;
    if (NON_UI_CALLEES.test(name)) return null;
    if (/^new \w*Error$/.test(name)) return "error";
    return `call:${name}`;
  }
  if (ts.isReturnStatement(p)) return "return";
  if (ts.isVariableDeclaration(p)) return `var:${p.name.getText()}`;
  if (ts.isTemplateSpan(p) || ts.isTemplateExpression(p)) return null;
  return "other";
}

// Turn a template literal into a "{0} … {1}" pattern.
function templatePattern(tpl) {
  let out = tpl.head.text;
  tpl.templateSpans.forEach((span, i) => {
    out += `{${i}}` + span.literal.text;
  });
  return out;
}

// Turn mixed JSX children (text + expressions) into a pattern.
function jsxChildrenPattern(el) {
  const kids = el.children;
  let hasText = false;
  let hasExpr = false;
  let idx = 0;
  let out = "";
  for (const k of kids) {
    if (ts.isJsxText(k)) {
      if (k.text.trim()) hasText = true;
      out += k.text;
    } else if (ts.isJsxExpression(k)) {
      if (!k.expression) continue; // comment
      if (ts.isStringLiteral(k.expression)) {
        out += k.expression.text;
        continue;
      }
      hasExpr = true;
      out += `{${idx++}}`;
    } else {
      return null; // nested elements: translated individually
    }
  }
  return hasText && hasExpr ? norm(out) : null;
}

function walk(sf, rel) {
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const t = norm(node.text);
      if (t && hasLetter(t)) add(t, "literal", "jsx-text", rel);
    } else if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const pat = jsxChildrenPattern(node);
      if (pat) add(pat, "template", "jsx-mixed", rel);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const ctx = classify(node);
      if (ctx) {
        const confident = ctx === "jsx-child" || ctx.startsWith("attr:") || ctx.startsWith("prop:");
        if ((confident && hasLetter(node.text) && !/^[a-z0-9_.:/@#-]+$/.test(node.text)) || looksLikeProse(node.text)) {
          add(node.text, "literal", ctx, rel);
        }
      }
    } else if (ts.isTemplateExpression(node)) {
      const ctx = classify(node);
      const pat = templatePattern(node);
      const literalPart = pat.replace(/\{\d+\}/g, " ");
      const confident = ctx && (ctx === "jsx-child" || ctx.startsWith("attr:") || ctx.startsWith("prop:"));
      const fixed = norm(literalPart).replace(/^[^A-Za-z]+/, "");
      if (
        ctx &&
        (looksLikeProse(fixed) || (confident && /[A-Za-z]{3,}/.test(fixed) && !isJunk(fixed))) &&
        !/[{}]{2}|[<>;=]/.test(literalPart)
      ) {
        add(pat, "template", ctx, rel);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function* files(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      yield* files(p);
    } else if (/\.[cm]?tsx?$/.test(ent.name) && !SKIP_FILE.test(p)) {
      yield p;
    }
  }
}

for (const d of SCAN_DIRS) {
  const abs = path.join(srcRoot, d);
  if (!fs.existsSync(abs)) continue;
  for (const f of files(abs)) {
    const code = fs.readFileSync(f, "utf8");
    const kind = f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(f, code, ts.ScriptTarget.Latest, true, kind);
    walk(sf, path.relative(srcRoot, f));
  }
}

// Keybinding command labels are generated at runtime from command ids
// ("thread.steerQueued" -> "Thread: Steer Queued"), mirroring commandLabel()
// in KeybindingsSettings.logic.ts. Emit each segment as a "cmd:" entry.
{
  const kbFile = "packages/contracts/src/keybindings.ts";
  const abs = path.join(srcRoot, kbFile);
  if (fs.existsSync(abs)) {
    const titleCase = (seg) =>
      seg
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" ");
    for (const m of fs.readFileSync(abs, "utf8").matchAll(/"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)"/g)) {
      for (const seg of m[1].split(".")) {
        if (/^\d+$/.test(seg)) continue;
        add(`cmd:${titleCase(seg)}`, "literal", "keybinding-command", kbFile);
      }
    }
  }
}

const out = [...results.values()]
  .map((e) => ({ text: e.text, kind: e.kind, ctx: [...e.ctx].sort(), files: [...e.files].sort() }))
  .sort((a, b) => a.text.localeCompare(b.text));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + "\n");
console.log(`${out.length} strings (${out.filter((e) => e.kind === "template").length} templates) -> ${outFile}`);
