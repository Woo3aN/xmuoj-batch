# XMUOJ Batch

XMUOJ 配套 VS Code 插件。

## 功能

| 命令 | 说明 |
|------|------|
| `XMUOJ: 批量提交评测` | 模拟手动提交流程，AC 自动关 tab，WA 保留窗口 |
| `XMUOJ: 批量本地测试` | 批量跑 samples 测试，缺样本自动尝试下载 |
| `XMUOJ: 批量下载样本数据` | 从 XMUOJ 下载缺失的测试样本 |
| `XMUOJ: 同步拉取 (git pull)` | 从 GitHub 拉取代码 |
| `XMUOJ: 提交并推送 (git push)` | 提交改动并推送 |
| `XMUOJ: 初始化 Git 仓库` | 新手一键配 Git |

## 安装

```bash
git clone https://github.com/Woo3aN/xmuoj-batch.git
# 复制到 VS Code 扩展目录
cp -r xmuoj-batch ~/.vscode/extensions/local.xmuoj-batch-1.0.0/
# 重启 VS Code
```

## 依赖

- VS Code ≥ 1.88
- [XMUOJ 插件](https://github.com/AndyLishengrui/xmuoj)
- Python 3（用于检查 AC 状态）
- Git（用于同步功能）

## Git 同步设置

首次使用前，在 XMUOJ 工作区目录下初始化 Git：

```bash
cd "你的XMUOJ工作区目录"
git init
git remote add origin <你的GitHub仓库地址>
```
