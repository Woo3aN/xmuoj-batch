# XMUOJ Batch

XMUOJ 配套 VS Code 插件，提供三个功能：

- 🚀 **批量提交评测** — 扫描所有题目，一键全部提交到 XMUOJ
- 📥 **git pull** — 拉取另一台电脑的代码
- 📤 **git push** — 提交并推送代码到 GitHub

## 安装

```bash
git clone https://github.com/Woo3aN/xmuoj-batch.git
# 复制到 VS Code 扩展目录
cp -r xmuoj-batch ~/.vscode/extensions/local.xmuoj-batch-1.0.0
```

或者直接下载，解压到 `C:\Users\<用户名>\.vscode\extensions\local.xmuoj-batch-1.0.0\`

## 使用

`Ctrl+Shift+P` 输入：

| 命令 | 说明 |
|------|------|
| `XMUOJ: 批量提交评测` | 扫描所有已开题且有代码的题目，多选后批量提交 |
| `XMUOJ: 同步拉取 (git pull)` | 从 GitHub 拉取最新代码 |
| `XMUOJ: 提交并推送 (git push)` | 提交改动并推送到 GitHub |

## Git 同步设置

首次使用前，在 XMUOJ 工作区目录下初始化 Git：

```bash
cd "你的XMUOJ工作区目录"
git init
git remote add origin <你的GitHub仓库地址>
```

## 依赖

- VS Code ≥ 1.88
- [XMUOJ 插件](https://marketplace.visualstudio.com/items?itemName=xmuoj.xmuoj-vscode)
- Python 3（用于更新题目 AC 状态）
