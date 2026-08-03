# P6 · 真隔离设计(WS1-1b)

> 目标:给研究/无代码 worker 一个**物理受限**的执行环境,而非只靠提示词。分层落地:已做的 scratch + 本阶段的配额看门狗 + 未来的容器/Job Object。

## 现状(已做)
- **scratch 短路径隔离**:noCode worker 跑在 `~/opcwt/<id>`(非 git、短路径)。好处:① 误建 Python 只在隔离短路径(monorepo 零污染、短路径避免 ENAMETOOLONG);② 用完整目录 rm 清理。
- **超时**:外层 `parallelExecutor` 200s + 内层 Hermes 240s。
- **诚实降级**:worker 失败/超时 → defer,不崩 run。

## 本阶段(P6 最小可用原型):磁盘配额看门狗
**问题**:worker 仍可能在 scratch 里建 Python(NO_CODE 提示词只 ~50% 有效),涨到几百 MB、耗满超时。scratch 隔离了"污染",但没"物理限制大小/及时止损"。

**做法**:在 `hermesBridge.runHermesNative`(子进程 spawn 处,已有 timeout-kill)加一个**配额看门狗**:
- 起一个 `setInterval`(~2s),扫描 worker 的 cwd(scratch dir)总字节数。
- 超过配额(来自 `roleProfile` 的 `maxWorkspaceBytes`,research_profile_v1 = 32MB)→ **kill 子进程**(与 timeout-kill 同路径)+ 标 `quotaExceeded`。
- 返回一个失败结果 → worker 以 `workspace_quota_exceeded` 理由 defer,run 继续(不崩)。

**配额从哪来(plumbing)**:`roleProfile.maxWorkspaceBytes` → `parallelExecutor.runOne`(noCode 时)置入 `ExecContext.workspaceQuotaBytes` → `HermesEngine.run` 读取 → `executeViaHermes` → `runHermesNative` 的看门狗。`ExecContext` 加一个**可选**字段(加性,不影响其他引擎/路径)。

**效果**:worker 一旦开始建 Python,几秒内 scratch 超 32MB → 被秒杀 → defer,**物理上限制了磁盘 + 及时止损**(不再耗满 200s)。这是"物理受限"的最小真实版本。

## 网络
worker 子进程在 Clash TUN 等环境下本就连不上网(HANDOFF 已知);OPC 靠**服务端 webBrief 注入**给 worker 真实网页。所以网络隔离对研究 worker 已是事实状态(它不能自己联网,只能用注入的资料)。后续可显式 env 白名单 / 防火墙规则进一步硬化。

## E6 升级:进程树 kill(P6 之上,已设计)

### 问题
`proc.kill()` 仅向直接子进程(hermes.exe)发信号。Windows 上 `proc.kill()` 发送
`TerminateProcess`,不级联到子进程树。Hermes 在执行 code_execution 工具时会自己 spawn Python
子进程;hermes.exe 被 kill 后这些 Python 子进程变成孤儿、继续占用 CPU/内存直到超时或 OS 回收。

### 方案:killProcessTree helper(纯 Node,无 native 依赖)

新建 `apps/server/src/runtime/processUtils.ts`,导出:

```typescript
killProcessTree(pid: number | undefined, kill: () => void): void
```

逻辑:
1. Win32 且 `pid != null` → `spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 })`
   - `/T`:递归杀整棵进程树;`/F`:强制(跳过 WM_CLOSE 协议)。
2. 始终调用传入的 `kill()`(Node 句柄清理),不论 taskkill 是否成功。
3. 所有异常全部 swallow——绝不抛出。

**为什么可以用 `spawnSync`**:taskkill 在毫秒级完成,且调用点已在 setTimeout/setInterval
回调中、正要 resolve promise,同步调用安全,不阻塞事件循环中的业务代码。

### 集成配方(hermesBridge.ts,精确 2 处)

见下方"对共享文件的精确配方"节(StructuredOutput)。

### 测试
`processUtils.test.ts`:5 个单测覆盖 win32/linux/pid-undefined/throw-from-taskkill/throw-from-kill
五条路径,全部不抛,kill() 恒被调用。已写入代码库。

---

## Windows Job Object 可行性评估(穷尽版诚实结论)

**结论:纯 Node.js 做不到 Job Object 限内存/CPU,不假装。**

### 什么是 Job Object
Windows Job Object 是内核对象:
- 把若干进程"绑定"到一个 Job 里,限 `JOBOBJECT_BASIC_LIMIT_INFORMATION`(CPU 时间/进程数)和
  `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`(commit 内存/working set);超限 → 整树被系统强杀。
- 比 taskkill 更彻底:进程不能"逃出" Job,子进程默认继承 Job 绑定。

### 为什么纯 Node 做不到
| 途径 | 可用? | 说明 |
|---|---|---|
| Node.js 内置 API | ✗ | `child_process.spawn` 不暴露 `CreateJobObject`/`AssignProcessToJobObject`/`SetInformationJobObject` |
| `node-gyp` native addon | 条件性 ✓ | 需 C++ 扩展(`windows-job-object` npm 包)+ MSVC/node-gyp 工具链;需随项目分发 `.node` 二进制;引入 ABI 兼容矩阵 |
| 外部 helper .exe | 条件性 ✓ | 写一个小 C# / C++ helper,由 Node 用 `spawn` 调用,helper 创建 Job 后 spawn 实际命令并把自身也加入 Job;复杂度高、分发负担大 |
| PowerShell / WMIC | ✗ | Win32 API 没有 Job Object 的 PowerShell cmdlet;WMIC 不暴露 Job Object |
| `taskkill` | 部分 ✓ | 能整树 kill(上方已做),但**不能事先限制资源**,只能事后终止 |

### 当前可行最大化方案

在不引入 native addon 的前提下,**"tree-kill + 磁盘配额看门狗"是技术上最完整的可行版**:

| 层次 | 机制 | 覆盖的风险 |
|---|---|---|
| scratch 短路径 | `~/opcwt/<id>`,非 git | monorepo 零污染;短路径避 ENAMETOOLONG |
| 磁盘配额看门狗 | `dirSizeExceeds` 每 2.5s 扫描 | 限磁盘增长:误建 Python 几秒被 kill |
| 进程树 kill | `taskkill /T /F` | 整树终止,消灭孤儿 Python 子进程 |
| 外层超时 | `parallelExecutor` 200s | 兜底:任何子进程异常都有总上限 |

**内存/CPU 硬限**:本阶段无法在不引入 native addon 的情况下实现。风险评估:
- Hermes 本身吃内存不多;Python 环境如果 pip install 了大包会先触发磁盘配额(几十 MB 内)被 kill,
  内存还未显著增长。因此磁盘配额是主要 kill 信号,内存/CPU 是次要风险。
- 若未来需要内存限制,推荐引入 `windows-job-object` npm 包并做 native 构建。

### 如果未来要上 Job Object

最小方案(`windows-job-object` npm 包路线):
```
npm install windows-job-object   # 有 native .node,需 node-gyp + MSVC
```
在 `runHermesNative` spawn 后,`proc.pid != null` 时:
```typescript
import { createJobObject, assignProcess } from "windows-job-object";
const job = createJobObject({ maxWorkingSetBytes: 512 * 1024 * 1024 }); // 512MB
assignProcess(job, proc.pid!);
```
kill 时调用 `terminateJob(job)` 代替 `killProcessTree`。
这是正确路线,但需要工具链投资,不在当前阶段做。

---

## 未来(更完整版)
- **容器 / VM**:最彻底(文件/网络/凭据全隔离),但 Windows 上重(Docker Desktop/WSL2),
  启动慢、磁盘开销大。适合"危险/不可信" worker 大规模跑时。
- **受限 Hermes 模式**:若 Hermes 提供"禁 code_execution 但仍响应"的模式则最优(目前禁了它整体不响应)。
- **Job Object + native addon**:见上方评估。

## 验收
配额看门狗接进 parallelExecutor/引擎链、`tsc=0`、全量测试不回归、1 次简单题真跑不破坏流水线(正常研究 worker 远不到 32MB,不受影响)= P6 完成。
E6 进程树 kill:新增 `processUtils.ts`(5 单测)、hermesBridge.ts 两处 kill 点替换、`tsc=0`、全量测试不回归 = E6 完成。
