# XMUOJ Batch 一键安装脚本
# 以管理员身份在 PowerShell 中运行，或直接运行即可

$extDir = "$env:USERPROFILE\.vscode\extensions\local.xmuoj-batch-1.0.0"

Write-Host "安装 XMUOJ Batch 插件..." -ForegroundColor Cyan

# 创建目录
New-Item -ItemType Directory -Force -Path $extDir | Out-Null

# 复制文件
Copy-Item -Force "$PSScriptRoot\package.json" $extDir
Copy-Item -Force "$PSScriptRoot\extension.js" $extDir
Copy-Item -Force "$PSScriptRoot\README.md" $extDir

Write-Host "✅ 安装完成！" -ForegroundColor Green
Write-Host "请重启 VS Code (Ctrl+Shift+P -> Developer: Reload Window)"
Write-Host ""
Write-Host "依赖:"
Write-Host "  - XMUOJ 插件: https://github.com/AndyLishengrui/xmuoj"
Write-Host "  - Python 3 (用于检查 AC 状态)"
Write-Host "  - Git"
