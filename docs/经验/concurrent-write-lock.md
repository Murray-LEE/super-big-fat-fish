---
id: concurrent-write-lock
trigger: 并发, 同时写, 锁, write
action: 并发写票板必须走 ticket-write 的锁 + 原子写
---
为什么：两个进程同时改同一个票板，后写的会覆盖先写的（或用旧内容重新写回）。
ticket-write 的 acquireLock + writeAtomic 保证一次只有一个人写，
第二个会被明确拒绝（exit 1 并给出锁路径），票板逐字不变。