---
id: repack-after-tools
trigger: 改 tools, 重构工具, 新增脚本, 打包
action: 改完 tools/ 必须 pack-release --pack 并跑 --check
---
为什么：发行包是从 tools/ 打出来的；只改工作树不重打包，
dist 里的包就和源码不一致，pack-release --check 会当场挂。
另外 README 一改也会让包与文档不一致 ⇒ 打包前先看文档版本号。