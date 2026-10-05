# T3 Code 中文界面（t3zh）

给 Windows 上的 T3 Code（WSL 后端模式）加中文界面，重点覆盖**设置页**。Windows 桌面客户端和浏览器网页版都支持，T3 更新后会自动重新生效。

## 原理

T3 的界面有两个来源，两处都要注入：

- **Windows 桌面客户端**：主窗口通过 `t3code://app/` 读取安装目录里 `resources/server.asar` 中的 `apps/server/dist/client`。
- **网页版 / 内置预览**：由 WSL 里的服务器提供：`~/.t3/wsl-runtime/sha256-*/client/`。

0. **桌面客户端注入**：`tools/patch-asar.mjs` 把内联了词典和翻译引擎的新 `index.html` 追加到 `server.asar` 末尾，并把文件头里的条目指过去。原始数据保留不动，文件头字节长度不变，其他 2000 多个文件不受影响（已逐字节校验）。T3 的 asar 完整性校验开关是关闭的，桌面端的 CSP 也允许内联脚本。`--remove` 可以把条目指回原文件。
1. **网页版注入**：`scripts/patch-runtime.sh` 在每个运行时的 `client/` 里放一个软链接 `t3zh/ → 本项目/runtime`，并在 `index.html` 的 `<head>` 中插入两行 `<script>`。不修改任何带哈希的打包文件。
2. **跟随更新**：systemd 用户单元 `t3zh-patch.path` 监视 `~/.t3/wsl-runtime/`。T3 每次更新都会解出一个新的 `sha256-*` 目录，触发后会同时给 WSL 运行时和 Windows 的 `server.asar` 重新打补丁。另有 `t3zh-patch.timer` 每 5 分钟检查一次作为兜底。补丁都是幂等的。
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

装完后**完全退出并重新打开** T3 Code 即可生效。运行中的 T3 会缓存 asar 文件头，所以只刷新窗口没有用。

- **Ctrl+Alt+L**：中英文切换
- 浏览器控制台中的 `__t3zh.missing()`：查看运行时遇到的未翻译文案

## T3 更新后补词典

插件本身不需要任何操作。如果新版本加了新文案，它们会先显示为英文，按下面步骤补上：

```sh
scripts/sync-upstream.sh      # 自动识别已安装版本，拉取对应 tag 的源码，列出缺失条目
# 翻译 extracted/missing.json 里的条目，写入 dict/zh-CN/*.json
# 不该翻译的（品牌名、命令、给 AI 的提示词）放进 dict/keep-en.json
node tools/build-dict.mjs     # 生成 runtime/dict.js
scripts/patch-runtime.sh      # 立即更新桌面客户端（也可以等定时器），然后重启 T3
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
| `scripts/patch-runtime.sh` | 注入 / 移除补丁（WSL 运行时 + 桌面客户端） |
| `tools/patch-asar.mjs` | 修改桌面客户端 `server.asar` 中的 `index.html` |
| `scripts/sync-upstream.sh` | T3 更新后同步源码并列出缺失条目 |
| `test/` | 引擎测试：`node --test test/*.test.mjs` |

## 限制

- T3 自动更新后的**第一次启动**还是英文：新版本已经启动，补丁要等 WSL 运行时安装后才打上。再重启一次就是中文了。
- 补丁依赖 WSL 能运行（systemd 用户服务负责打补丁）。
- T3 运行时更新词典，新内容只能追加到 asar 末尾，每次大约 0.3 MB。T3 关闭时再打补丁会回收这部分空间。
- Electron 原生菜单和系统对话框不在网页 DOM 里，无法翻译。
- 新版本新增的文案，在补进词典之前会显示英文。
