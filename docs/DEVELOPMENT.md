# 开发与验证

## 准备环境

使用 Node.js 22+ 和 pnpm 10.28.2。依赖版本由 `pnpm-lock.yaml` 固定。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

默认地址是 `http://127.0.0.1:4317/`。首次启动创建空白资料目录并展示 Onboarding，不附带用户工作数据。AI CLI 需要用户自行安装、登录，并配置所需工具或插件；仅安装本仓库不提供飞书访问权限。

## 隔离运行

使用不同的数据目录与端口，不复用日常工作的资料：

```sh
TASKPILOT_DATA_DIR="$(mktemp -d)" TASKPILOT_PORT=4318 pnpm dev
```

每个数据目录只允许一个服务进程持有运行锁。停止服务用 Ctrl+C；不要删除其他正在运行进程的锁。

生产模式先构建再启动：

```sh
pnpm build
pnpm start
```

## 验证

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

默认测试使用临时目录和受控模型实现，涵盖实际状态转移、持久化、并发和失败路径，不调用真实模型。GitHub Actions 在 push 与 pull_request 上执行相同检查。

界面变更使用隔离服务验证，重点检查首次引导、双会话入口、保存与推进的区分、运行中继续审阅，以及重新加载后的状态恢复。

`pnpm validate -- <workspace>` 只读校验资料格式，不启动模型。`server/local-model.smoke.ts` 是真实模型烟测入口，仅在明确获得测试授权后使用；需要额外设置 `TASKPILOT_RUN_REAL_AGENT_SMOKE=1`，不属于默认 CI。

## 代码与数据

| 目录 | 责任 |
| --- | --- |
| `src/` | React 页面与交互 |
| `core/` | 共享协议、查询及工作日时间窗口 |
| `server/` | HTTP、文件存储、执行器与调度 |
| `.agents/skills/taskpilot-files/` | 随应用安装的工作约定与计划模板 |
| `docs/` | 架构与验证说明 |

应用数据默认在源码外的 `~/.TaskPilot/`。源码仓库不保存账号配置、背景资料、聊天、工作卡片或恢复草稿；自定义数据目录时也应放在仓库之外。提交前检查暂存区，不提交 `.env` 或本机凭据。
