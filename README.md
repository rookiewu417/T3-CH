# T3 Code 中文界面（t3zh）

给 Windows 上的 T3 Code（WSL 后端模式）加中文界面，重点覆盖**设置页**。T3 更新后插件不会失效，也不需要改 T3 的安装文件。

## 原理

T3 Code 的界面由 WSL 里的服务器提供：`~/.t3/wsl-runtime/sha256-*/client/`。

1. **注入**：`scripts/patch-runtime.sh` 在每个运行时的 `client/` 里放一个软链接 `t3zh/ → 本项目/runtime`，并在 `index.html` 的 `<head>` 中插入两行 `<script>`。不修改任何带哈希的打包文件。
2. **跟随更新**：systemd 用户单元 `t3zh-patch.path` 监视 `~/.t3/wsl-runtime/`。T3 每次更新都会解出一个新的 `sha256-*` 目录，补丁会在一秒内自动重新打上。补丁是幂等的，只处理带有就绪标记的完整目录。
3. **翻译**：`runtime/t3zh.js` 用 MutationObserver 把界面上的英文替换成中文，并保留原文。
   - 词典按英文原文匹配，不依赖代码位置，所以 T3 重构代码不会让它失效。
   - 支持带占位符的模板（`Delete {0} files`）、被 React 拆成多个文本节点的句子，以及快捷键命令名（`Thread: Next` 会按段翻译）。
   - **不会翻译**聊天正文、Markdown、代码、diff、终端、输入框里的内容。
   - 词典里没有的文案保持英文，不会把界面弄坏。
   - 带熔断保护：如果和某个组件形成改写循环，会自动暂停 2 秒，而不是卡死 T3。

## 安装 / 卸载

```sh
./install.sh            # 构建词典、安装 systemd 监视、给现有运行时打补丁
./install.sh --remove   # 卸载，恢复 T3 原始文件
```

装完后重启 T3 Code（或重新加载窗口）即可生效。

- **Ctrl+Alt+L**：中英文切换
- 浏览器控制台中的 `__t3zh.missing()`：查看运行时遇到的未翻译文案

## T3 更新后补词典

插件本身不需要任何操作。如果新版本加了新文案，它们会先显示为英文，按下面步骤补上：

```sh
scripts/sync-upstream.sh      # 自动识别已安装版本，拉取对应 tag 的源码，列出缺失条目
# 翻译 extracted/missing.json 里的条目，写入 dict/zh-CN/*.json
# 不该翻译的（品牌名、命令、给 AI 的提示词）放进 dict/keep-en.json
node tools/build-dict.mjs     # 生成 runtime/dict.js，刷新 T3 窗口即可生效（软链接，无需重新安装）
```

覆盖范围由 `tools/scope.mjs` 定义：从设置页路由出发，沿 import 依赖图找到的所有文件，再加上服务端的提供方和源代码管理状态信息。

## 目录

| 路径 | 作用 |
|---|---|
| `runtime/t3zh.js` | 页面内的翻译引擎 |
| `runtime/dict.js` | 生成的词典（不要手改） |
| `dict/zh-CN/*.json` | 词典源文件（英文 → 中文） |
| `dict/keep-en.json` | 有意保持英文的条目 |
| `tools/extract-strings.mjs` | 用 TypeScript AST 从 t3code 源码提取界面文案 |
| `tools/check-dict.mjs` | 检查词典覆盖率 |
| `scripts/patch-runtime.sh` | 注入 / 移除补丁 |
| `scripts/sync-upstream.sh` | T3 更新后同步源码并列出缺失条目 |
| `test/` | 引擎测试：`node --test test/*.test.mjs` |

## 限制

- 只支持 WSL 后端模式（目前就是这种模式）。如果切换成 Windows 原生后端，界面会改由 `server.asar` 提供，这个方案就覆盖不到了。
- Electron 原生菜单和系统对话框不在网页 DOM 里，无法翻译。
- 新版本新增的文案，在补进词典之前会显示英文。
