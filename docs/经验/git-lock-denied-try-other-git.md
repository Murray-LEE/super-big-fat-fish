---
id: git-lock-denied-try-other-git
trigger: index.lock, Permission denied, git add, git commit, 提交失败, 锁
action: 遇到 `index.lock: Permission denied` 先手动建一次同名文件；手动能建就换另一个 git 二进制重试
---
为什么：2026-11-03 在酒馆仓提交经验文件时，`git add` 一直报
`Unable to create '.git/index.lock': Permission denied`。

排查顺序与结论：

1. `.git` 目录 ACL 没有 DENY（`icacls` 全是 Allow）；
2. 手动 `New-Item .git\index.lock` **能建**，能删；
3. 临时仓 `git init` 也报 `".git: Permission denied"`；
4. `GIT_INDEX_FILE` 换到仓库内 ⇒ 仍然 `.lock: Permission denied`；
5. 换成机器上**另一个** git 二进制（版本较新的那个）⇒ **立刻成功**。

结论：不是权限配置问题，是**那个便携版 git 在这台机器上建不了点开头的文件**（`.git` 目录、`.lock` 锁文件）。

所以判据是：**手动能建同名文件 ⇒ 换 git 二进制**；手动也建不了 ⇒ 才去查权限。
