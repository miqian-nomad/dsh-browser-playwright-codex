# autocommit.ps1 —— 每日自动存档：有改动就提交一条带时间戳的 commit。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File D:\dsh-plugins\dsh-browser-playwright\scripts\autocommit.ps1
#
# 注册成每天 23:55 的计划任务（一次即可，用户级，不需要管理员）:
#   schtasks /create /tn "dsh-browser-playwright autocommit" /sc daily /st 23:55 ^
#     /tr "powershell -ExecutionPolicy Bypass -File D:\dsh-plugins\dsh-browser-playwright\scripts\autocommit.ps1"
#
# 说明：这是"存档"，不是"分支管理"。它只提交，从不 push、reset 或丢弃改动，
# 所以最坏情况也只是历史里多一条记录。
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not (Test-Path (Join-Path $repo '.git'))) { Write-Output "not a git repo: $repo"; exit 0 }

$changes = git status --porcelain
if (-not $changes) { Write-Output '没有改动，跳过'; exit 0 }

git add -A
git commit -q -m ("auto: " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
Write-Output ("已存档: " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
