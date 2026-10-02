"""校验仓库里所有 markdown 链接：文件路径要存在，锚点要能在目标文档里找到。

为什么需要：
 1. 那几篇文档原来放在 GitHub 的 docs/ 下，链接写的是 ../xxx；搬进本仓库根目录后
    ../ 就指到仓库外了。靠肉眼容易漏，脚本一跑就知道。
 2. 锚点也会坏：曾经有过 `[help wanted #2](README.md#help-wanted--求助)`，
    而 README 里根本没有那一节 —— 文件在、锚点不在，照样是死链。

跑法（无需依赖，Python 3.8+）：
    python scripts/check-doc-links.py
退出码 0 = 全部有效；1 = 有坏链（逐条列出，标明是文件缺失还是锚点缺失）。
"""
import os
import re
import sys

# 以本文件位置为准：scripts/ 的上一级就是仓库根，换机器也不用改路径
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LINK = re.compile(r"\]\(([^)\s]+)\)")
HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")


def slug(heading: str) -> str:
    """GitHub 的标题锚点规则（近似实现）：小写；去掉非字母数字/连字符/下划线；
    空格转连字符。中文是字母数字（str.isalnum() 为真）所以保留，与 GitHub 一致。"""
    out = []
    for ch in heading.strip().lower():
        if ch.isalnum() or ch in "-_":
            out.append(ch)
        elif ch == " ":
            out.append("-")
    return "".join(out)


def anchors_of(path: str) -> set:
    """该文档所有标题的锚点。代码块内的 # 行不算标题。"""
    found = set()
    in_fence = False
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if FENCE.match(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            m = HEADING.match(line)
            if m:
                found.add(slug(m.group(1)))
    return found


def main() -> int:
    bad = []
    checked_files = 0
    checked_anchors = 0
    anchor_cache = {}

    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "lib")]
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, REPO)
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()

            for target in LINK.findall(text):
                if target.startswith(("http://", "https://", "mailto:")):
                    continue
                file_part, _, anchor = target.partition("#")
                file_part = file_part.split("?", 1)[0]

                if file_part == "":
                    # 同文档锚点：指向"更靠下的小节标题"是常见写法，这里只校验它存在
                    target_path = path
                else:
                    target_path = os.path.normpath(
                        os.path.join(os.path.dirname(path), file_part.replace("/", os.sep))
                    )
                    checked_files += 1
                    if not os.path.exists(target_path):
                        bad.append((rel, target, "文件不存在: " + os.path.relpath(target_path, REPO)))
                        continue

                if anchor == "":
                    continue
                if not target_path.endswith(".md"):
                    continue
                checked_anchors += 1
                if target_path not in anchor_cache:
                    anchor_cache[target_path] = anchors_of(target_path)
                if anchor not in anchor_cache[target_path]:
                    bad.append(
                        (
                            rel,
                            target,
                            "锚点不存在: #" + anchor + "  (该文档有 "
                            + str(len(anchor_cache[target_path]))
                            + " 个标题锚点)",
                        )
                    )

    print(f"检查了 {checked_files} 个文件链接、{checked_anchors} 个锚点，坏链 {len(bad)} 个")
    for src, target, why in bad:
        print(f"  BAD  {src}  ->  {target}   ({why})")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
