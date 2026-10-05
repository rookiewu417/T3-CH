// Embedded into app.asar by patch-asar.mjs; only menu labels are translated.
function createT3zhNativeMenu(dict) {
  const roles = { cut: "剪切", copy: "复制", paste: "粘贴", selectAll: "全选", undo: "撤销", redo: "重做", pasteAndMatchStyle: "粘贴并匹配样式" };
  const templates = Object.entries(dict).filter(([key]) => /\{\d+\}/.test(key)).map(([key, zh]) => {
    const order = [];
    const parts = key.split(/(\{\d+\})/).map(part => {
      if (/^\{\d+\}$/.test(part)) { order.push(part.slice(1, -1)); return "(.+?)"; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    });
    return { re: new RegExp("^" + parts.join("") + "$"), order, zh, fixed: key.replace(/\{\d+\}/g, "").length };
  }).filter(t => t.fixed >= 5).sort((a, b) => b.fixed - a.fixed);
  function translate(label) {
    if (typeof label !== "string") return label;
    if (Object.hasOwn(dict, label)) return dict[label];
    if (label.length > 200) return label;
    for (const t of templates) {
      const match = t.re.exec(label);
      if (!match || match.slice(1).some(s => !Object.hasOwn(dict, s) && (s.match(/\b[a-z]{2,}\b/g) || []).length >= 3)) continue;
      const values = {};
      t.order.forEach((index, i) => { values[index] = dict[match[i + 1]] ?? match[i + 1]; });
      return t.zh.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? "");
    }
    return label;
  }
  return function translateMenu(items, labels = true) {
    return items.map(item => ({
      ...item,
      ...(typeof item.label === "string" && labels ? { label: translate(item.label) } : !item.label && roles[item.role] ? { label: roles[item.role] } : {}),
      ...(Array.isArray(item.submenu) ? { submenu: translateMenu(item.submenu, labels) } : {}),
    }));
  };
}
module.exports = { createT3zhNativeMenu };
