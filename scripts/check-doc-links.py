"""校验仓库里所有 markdown 相对链接是否有对应文件（只查本地路径，跳过 http/#）。

为什么需要：那几篇文档原来放在 GitHub 的 docs/ 下，链接写的是 ../xxx；
搬进本仓库根目录后 ../ 就指到仓库外了。靠肉眼容易漏，脚本一跑就知道。

跑法（无需依赖，Python 3.8+）：
    python scripts/check-doc-links.py
退出码 0 = 全部链接有效；1 = 有坏链（逐条列出）。
"""
import os
import re
import sys

# 以本文件位置为准：scripts/ 的上一级就是仓库根，换机器也不用改路径
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LINK = re.compile(r"\]\(([^)\s]+)\)")

bad = []
checked = 0
for root, dirs, files in os.walk(REPO):
    dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "lib")]
    for name in files:
        if not name.endswith(".md"):
            continue
        path = os.path.join(root, name)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        for target in LINK.findall(text):
            if target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            anchor = target.split("#", 1)[0]
            if not anchor:
                continue
            checked += 1
            resolved = os.path.normpath(os.path.join(os.path.dirname(path), anchor.replace("/", os.sep)))
            if not os.path.exists(resolved):
                bad.append((os.path.relpath(path, REPO), target, os.path.relpath(resolved, REPO)))

print(f"检查了 {checked} 个相对链接，坏链 {len(bad)} 个")
for src, target, resolved in bad:
    print(f"  BAD  {src}  ->  {target}   (解析为 {resolved})")
sys.exit(1 if bad else 0)
