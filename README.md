# XMUOJ Batch

XMUOJ 配套 VS Code 插件 — 批量提交、本地测试、Git 同步一站式。

## 功能

| 命令 | 说明 |
|------|------|
| `XMUOJ: 批量提交评测` | 一键提交所有已开题的代码到 XMUOJ 平台评测，AC 自动关 tab，WA 保留窗口 |
| `XMUOJ: 批量本地测试` | 批量编译运行，对比 samples 判定 AC/WA，缺样本自动下载 |
| `XMUOJ: 批量下载样本数据` | 从 XMUOJ 下载缺失的测试样本（`.in` / `.out`） |
| `XMUOJ: 同步拉取 (git pull)` | 从 GitHub 拉取代码（先自动提交本地改动） |
| `XMUOJ: 提交并推送 (git push)` | 一键 `git add` + `commit` + `push` |
| `XMUOJ: 初始化 Git 仓库` | 新手一键配 Git（`git init` + `git remote add`） |

## 安装

从 [GitHub Releases](https://github.com/Woo3aN/xmuoj-batch/releases) 下载最新 `.vsix` 文件，拖入 VS Code 扩展面板安装。或通过脚本安装：

```powershell
# PowerShell
powershell -ExecutionPolicy Bypass -File install.ps1
```

## 依赖

- **VS Code** ≥ 1.88
- **[XMUOJ 插件](https://github.com/AndyLishengrui/xmuoj)**（`xmuoj.xmuoj-vscode`）
- **Python 3**（自动检测常见安装路径，无需手动配置 PATH）
- **Git**（用于同步功能）

## 配置

在 VS Code 设置中配置 XMUOJ 工作区路径：

```json
{
  "xmuoj.localWorkspaceRoot": "D:\\vscode c++"
}
```

## Git 同步设置

首次使用前，在 XMUOJ 工作区目录下初始化 Git：

```bash
cd "你的XMUOJ工作区目录"
git init
git remote add origin <你的GitHub仓库地址>
```

建议在 `.gitignore` 中排除编译产物，避免两台电脑间二进制冲突：

```gitignore
# 编译产物（每台电脑本地编译生成，不上传）
*.exe
*.o
*.obj
.xmuoj-build/
```

## 使用流程

### 多台电脑同步写题

```
电脑A                     GitHub                   电脑B
─────                     ──────                   ─────
写代码 → 批量本地测试
提交并推送       ──→      仓库更新       ──→     同步拉取
                                                 批量本地测试 → 写代码
同步拉取         ←──      仓库更新       ←──     提交并推送
```

### 批量提交到平台评测

1. `XMUOJ: 批量提交评测`
2. 等待逐个提交并获取结果
3. AC 的题自动关 tab，WA 保留窗口方便调试

## 常见问题

### Q: 批量本地测试显示"有失败"但实际全部通过？

检查 Python 是否已安装。插件会自动探测以下路径：
- `%LOCALAPPDATA%/Programs/Python/Python3xx/python.exe`
- `C:/Python3xx/python.exe`
- 系统 PATH 中的 `python`

### Q: `git pull` 报错 "local changes would be overwritten"？

说明本地 `.xmuoj-build/` 中有未提交的编译产物。已在上面的 `.gitignore` 方案中解决——排除编译产物后不会再出现此问题。
