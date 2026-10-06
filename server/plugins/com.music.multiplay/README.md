# com.music.multiplay

Tailchat 群组同步音乐房间插件（全栈）。

以 `groupId` 作为音乐房间 ID，服务端维护权威播放状态，房间内所有成员同步播放同一首歌。

## 架构

```
浏览器 (React 插件)
  ├─ HTTP: plugin:com.music.multiplay.<action>   # 发送动作
  └─ Socket: notify:plugin:com.music.multiplay.<event>  # 接收状态
        │
Tailchat Gateway (Socket.IO + HTTP)
        │
MultiplayService (TcService)
  ├─ Redis  : 实时权威状态 + 分布式锁/租约/限流/上游缓存
  ├─ MongoDB: 耐久快照（Redis 缺失时用于恢复）
  └─ GD Studio API (仅服务端访问)
```

- **不新增独立服务**：复用 Moleculer `TcService`、Gateway、Socket.IO 与 Redis。
- **Redis 是权威状态**：`services/musicRoomStore.ts` 使用「房间锁 + revision CAS + 有界重试」，
  多实例并发修改不会互相覆盖；读路径通过单次 Lua 原子返回 `{状态, Redis 时钟}`，
  播放时间由 `baseTime + playingSince` 推导，避免节点时钟偏移与「读操作写库」。
- **MongoDB 只是快照**：结构性变更即时落库，广播 tick 每房最多 30s 落一次；Redis 缺失时恢复。
- **通知按成员投递**：使用 `listcastNotify` 定向到房间成员（跨标签页安全），
  不操作核心的群组 Socket.IO room（核心已把群成员加入 `groupId` room，插件不应 leave）。

## Action

| action | 参数 | 权限 |
| --- | --- | --- |
| `getState` | `groupId` | 群成员 |
| `join` | `groupId`, `userName?` | 群成员 |
| `leave` | `groupId` | 群成员 |
| `add` | `groupId`, `track` | 群成员（30 次/分钟） |
| `remove` / `clear` | `groupId`, `trackId?` | room owner |
| `play` / `pause` / `seek` / `next` / `prev` | `groupId`, `time?` | 群成员（禁播者除外） |
| `volume` | `groupId`, `volume` | room owner（房间音量） |
| `mute` | `groupId`, `memberId` | `core.manageUser` |
| `search` / `url` / `lyric` / `pic` | GD Studio 参数 | 已登录用户 |

### 限流

每用户 / 每房间，计数基准为 Redis `TIME`：

- 传输类 `play/pause/seek/next/prev/volume` 共享 10 次/分钟，其中 `play/pause/seek` 额外 5 秒冷却
- `add` 30 次/分钟（便于连续点歌）
- `remove/clear/mute` 各 10 次/分钟
- Redis 不可用时控制类操作 **fail-closed**

## 事件

服务端下发的事件名为 `notify:plugin:com.music.multiplay.<event>`。

> 客户端 `AppSocket.listen()` 会自行补 `notify:` 前缀，因此前端订阅
> `plugin:com.music.multiplay.<event>`（不带前缀）。
> 常量定义：`services/events.ts` 与 `web/plugins/com.music.multiplay/src/events.ts`。

| 事件 | payload |
| --- | --- |
| `stateUpdate` | 完整房间状态（`MusicRoomDto`），带 `revision` |
| `progressSync` | `{ groupId, currentTime, isPlaying }` |
| `ownerChanged` | `{ groupId, ownerId }` |

加入房间时只向新成员单播完整状态，并向房间广播一次 `progressSync`。

## Redis key

前缀为 `cacher.prefix` + `plugin:com.music.multiplay:`（默认 `TC-`）：

| key | 说明 |
| --- | --- |
| `room:<groupId>` | 房间状态 JSON，TTL 6h |
| `activeRooms` | ZSET，score 为最后活跃时间，用于广播扫描与修剪 |
| `lock:<groupId>` | 房间互斥锁（`SET NX PX`，token 校验释放） |
| `leader` | 广播节点租约 |
| `rate:*` | 控制限流（冷却 / 窗口） |
| `music:*` | GD Studio 缓存与单飞锁 |
| `gd:budget` | GD Studio 上游滑动窗口预算（默认 50 次 / 5 分钟） |

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GD_API_BASE_URL` | `https://music-api.gdstudio.xyz` | GD Studio API 地址，实际请求 `${base}/api.php` |

## 失败策略

| 场景 | 行为 |
| --- | --- |
| Redis 不可用 + 控制类写操作 | fail-closed，返回 503 |
| Redis 不可用 + `getState` | fail-open，读 Mongo 快照并带 `degraded: true` |
| Redis 不可用 + GD 代理 | fail-open，降级为进程内缓存 + 每节点预算（warn 日志） |
| GD 返回 4xx/5xx | 抛错且**不写缓存** |
| GD 刷新失败 | 有 stale 数据时返回 stale |
| GD 预算耗尽 | 有 stale 用 stale，否则返回 429 `MUSIC_PROVIDER_BUSY` |
| 两节点并发修改 | 房间锁 + revision CAS 重试，不丢更新 |

## 离线清理与 owner 交接

- 在线判定复用 `gateway.checkUserOnline`（Redis per-user 在线映射，多标签页安全）。
- leader 节点每 10s 扫描活跃房间，成员连续 2 次（≈20s）判定离线才移除。
- owner 被移除时提升 `joinedAt` 最小的剩余成员，并广播 `ownerChanged` + `stateUpdate`。

已知限制：`tailchat-socketio.online:<userId>` 的 TTL 在连接时设为 1 天且不续期，
超长连接（>1 天）可能被误判离线；插件用「连续 2 次」缓解，彻底修复需改动核心。

## 开发与验证

```bash
# 前端类型检查（此前插件源码不被任何仓库命令覆盖）
pnpm --dir server/plugins/com.music.multiplay check:type

# 打包
pnpm --dir server/plugins/com.music.multiplay build:web

# 测试
pnpm --dir server test --runInBand plugins/com.music.multiplay   # 后端
pnpm --dir server/plugins/com.music.multiplay test:web           # 前端

# 真实依赖测试
REDIS_URL=redis://127.0.0.1:6379 pnpm --dir server test --runInBand plugins/com.music.multiplay
MONGO_URL=mongodb://127.0.0.1:27017/tailchat pnpm --dir server test --runInBand plugins/com.music.multiplay
```

- 纯逻辑与假 Redis 用例始终运行。
- 需要真实 Redis 的用例在缺少 `REDIS_URL` 时跳过。
- 需要 MongoDB 的服务集成用例在缺少 `MONGO_URL` 时跳过。
