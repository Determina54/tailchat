import {
  TcService,
  TcDbService,
  TcContext,
  TcPureContext,
  NoPermissionError,
  EntityError,
  RateLimitError,
  Errors,
  call,
  PERMISSION,
  SYSTEM_USERID,
} from 'tailchat-server-sdk';
import type { MultiplayDocument, MultiplayModel } from '../models/multiplay';
import {
  MUSIC_EVENTS,
  MUSIC_SERVICE_NAME,
  MusicOwnerChangedPayload,
  MusicProgressPayload,
} from './events';
import {
  MusicRoomDto,
  MusicRoomState,
  MultiplayTrack,
  addTrack,
  advanceNext,
  advancePrev,
  applyPresence,
  canControl,
  clearQueue,
  createInitialState,
  currentTimeOf,
  isOwner,
  memberIds,
  normalizeState,
  removeMember,
  removeTrack,
  seek as seekState,
  setMemberMuteUntil,
  setPlaying,
  setVolume,
  toDto,
  touchMember,
  upsertMember,
} from './musicRoomState';
import {
  MusicRoomConflictError,
  MusicRoomLockTimeoutError,
  MusicRoomStore,
  RedisLike,
} from './musicRoomStore';
import {
  GdCacheRedisLike,
  GdStudioBusyError,
  createGdStudioCache,
} from './gdStudioCache';
import {
  GdStudioClient,
  GdStudioError,
  MUSIC_SOURCES,
  MusicSource,
} from './gd-studio';
import { MusicControlRateLimiter, RateLimitRedisLike } from './rateLimit';

/**
 * 多实例参数
 */
const PROGRESS_INTERVAL_MS = 2000;
const LEADER_TTL_MS = 6000;
const PRESENCE_INTERVAL_MS = 10000;
const SNAPSHOT_INTERVAL_MS = 30000;
const MUTE_MS = 5 * 60 * 1000;

/**
 * 单条歌词的最大存储长度，防止客户端写入超大内容
 */
const MAX_LYRIC_LENGTH = 100 * 1024;

type RedisClientLike = RedisLike &
  GdCacheRedisLike &
  RateLimitRedisLike;

/**
 * multisic
 *
 * 听音乐插件：以 groupId 作为音乐房间 ID，服务端维护权威播放状态
 *
 * NOTICE:
 * - 实时权威状态在 Redis（见 musicRoomStore.ts），Mongo 只是耐久快照。
 * - 通知按房间成员列表 listcast，避免操作核心 socket room（群组 room 由核心维护）。
 */
interface MultiplayService
  extends TcService,
    TcDbService<MultiplayDocument, MultiplayModel> {}
class MultiplayService extends TcService {
  private progressTimer?: ReturnType<typeof setInterval>;
  private presenceTimer?: ReturnType<typeof setInterval>;
  private roomStore?: MusicRoomStore;
  private rateLimiter?: MusicControlRateLimiter;
  private gdClient?: GdStudioClient;
  private readonly lastSnapshotAt = new Map<string, number>();

  get serviceName(): string {
    return MUSIC_SERVICE_NAME;
  }

  onInit(): void {
    this.registerLocalDb(require('../models/multiplay').default);

    this.registerAction('getState', this.getState, {
      params: { groupId: 'string' },
    });
    this.registerAction('join', this.join, {
      params: {
        groupId: 'string',
        userName: { type: 'string', optional: true },
      },
    });
    this.registerAction('leave', this.leave, {
      params: { groupId: 'string' },
    });
    this.registerAction('add', this.add, {
      params: { groupId: 'string', track: 'object' },
    });
    this.registerAction('remove', this.remove, {
      params: { groupId: 'string', trackId: 'string' },
    });
    this.registerAction('clear', this.clear, {
      params: { groupId: 'string' },
    });
    this.registerAction('play', this.play, {
      params: { groupId: 'string' },
    });
    this.registerAction('pause', this.pause, {
      params: { groupId: 'string' },
    });
    this.registerAction('seek', this.seek, {
      params: { groupId: 'string', time: 'number' },
    });
    this.registerAction('next', this.next, {
      params: { groupId: 'string' },
    });
    this.registerAction('prev', this.prev, {
      params: { groupId: 'string' },
    });
    this.registerAction('volume', this.volume, {
      params: { groupId: 'string', volume: 'number' },
    });
    this.registerAction('mute', this.mute, {
      params: { groupId: 'string', memberId: 'string' },
    });
    this.registerAction('search', this.search, {
      params: {
        name: 'string',
        source: { type: 'string', optional: true },
        count: { type: 'number', optional: true },
        pages: { type: 'number', optional: true },
      },
    });
    this.registerAction('url', this.url, {
      params: {
        id: 'string',
        source: { type: 'string', optional: true },
        br: { type: 'number', optional: true },
      },
    });
    this.registerAction('lyric', this.lyric, {
      params: { id: 'string', source: { type: 'string', optional: true } },
    });
    this.registerAction('pic', this.pic, {
      params: {
        id: 'string',
        source: { type: 'string', optional: true },
        size: { type: 'number', optional: true },
      },
    });
  }

  protected async onStart(): Promise<void> {
    this.progressTimer = setInterval(() => {
      void this.tickProgress().catch((error) => {
        this.logger.warn('进度广播失败', error);
      });
    }, PROGRESS_INTERVAL_MS);

    this.presenceTimer = setInterval(() => {
      void this.tickPresence().catch((error) => {
        this.logger.warn('在线清理失败', error);
      });
    }, PRESENCE_INTERVAL_MS);
  }

  protected async onStop(): Promise<void> {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }

    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = undefined;
    }
  }

  /* ------------------------------------------------------------------ *
   * 基础设施
   * ------------------------------------------------------------------ */

  /**
   * 获取 Redis 客户端与部署命名空间前缀
   */
  private resolveNamespace(): { client: RedisClientLike | null; prefix: string } {
    const cacher = (
      this.broker as unknown as {
        cacher?: { client?: unknown; prefix?: string };
      }
    ).cacher;

    const raw = cacher?.client as RedisClientLike | undefined;
    const client =
      raw && typeof (raw as RedisLike).eval === 'function' ? raw : null;
    const prefix = cacher?.prefix
      ? `${cacher.prefix}plugin:com.music.multiplay:`
      : 'plugin:com.music.multiplay:';

    return { client, prefix };
  }

  /**
   * 房间状态存储；Redis 未就绪时 fail-closed
   */
  private getRoomStore(): MusicRoomStore {
    if (this.roomStore) {
      return this.roomStore;
    }

    const { client, prefix } = this.resolveNamespace();
    if (!client) {
      throw new Errors.MoleculerError(
        '音乐房间服务暂不可用（Redis 未就绪）',
        503,
        'MUSIC_STATE_UNAVAILABLE'
      );
    }

    this.roomStore = new MusicRoomStore(client, { prefix });
    return this.roomStore;
  }

  private getRateLimiter(): MusicControlRateLimiter {
    if (this.rateLimiter) {
      return this.rateLimiter;
    }

    const { client, prefix } = this.resolveNamespace();
    if (!client) {
      throw new RateLimitError(
        '音乐控制服务暂不可用',
        'MUSIC_CONTROL_UNAVAILABLE'
      );
    }

    this.rateLimiter = new MusicControlRateLimiter(client, prefix);
    return this.rateLimiter;
  }

  private getGdClient(): GdStudioClient {
    if (this.gdClient) {
      return this.gdClient;
    }

    const { client, prefix } = this.resolveNamespace();
    const cache = createGdStudioCache(client, {
      prefix,
      logger: {
        warn: (message: string, ...args: unknown[]) =>
          this.logger.warn(message, ...args),
      },
    });

    this.gdClient = new GdStudioClient(cache, {
      baseUrl: process.env.GD_API_BASE_URL,
    });

    return this.gdClient;
  }

  /**
   * 定时任务使用的系统上下文
   */
  private systemContext(): TcPureContext {
    const broker = this.broker;

    return {
      call: (action: string, params?: unknown, opts?: unknown) =>
        broker.call(action, params as never, opts as never),
      meta: { userId: SYSTEM_USERID },
    } as unknown as TcPureContext;
  }

  /* ------------------------------------------------------------------ *
   * 权限
   * ------------------------------------------------------------------ */

  private async ensureMember(ctx: TcContext, groupId: string) {
    const group = await call(ctx).getGroupInfo(groupId);
    const userId = String(ctx.meta.userId);

    if (!group) {
      throw new NoPermissionError(ctx.meta.t('群组不存在'));
    }

    const member = (group.members ?? []).find(
      (item) => String(item.userId) === userId
    );

    if (!member) {
      throw new NoPermissionError(ctx.meta.t('不是群组成员'));
    }

    return { group, member, userId };
  }

  private toEpochMs(value: unknown): number | undefined {
    if (value instanceof Date) {
      return value.valueOf();
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private assertOwner(
    ctx: TcContext,
    state: MusicRoomState,
    userId: string
  ): void {
    if (!isOwner(state, userId)) {
      throw new NoPermissionError(ctx.meta.t('没有操作权限'));
    }
  }

  /**
   * 群组禁言与房间禁播都视为不可控制
   */
  private assertCanControl(
    ctx: TcContext,
    state: MusicRoomState,
    userId: string,
    groupMuteUntil: unknown,
    now: number
  ): void {
    const result = canControl(
      state,
      userId,
      this.toEpochMs(groupMuteUntil),
      now
    );

    if (!result.allowed) {
      throw new NoPermissionError(ctx.meta.t('当前处于禁播状态'));
    }
  }

  private async requireManageUser(
    ctx: TcContext,
    groupId: string
  ): Promise<void> {
    const [hasPermission] = await call(ctx).checkUserPermissions(
      groupId,
      String(ctx.meta.userId),
      [PERMISSION.core.manageUser]
    );

    if (!hasPermission) {
      throw new NoPermissionError(ctx.meta.t('没有操作权限'));
    }
  }

  private async checkControlRate(
    ctx: TcContext,
    groupId: string,
    userId: string,
    action: string
  ): Promise<void> {
    const limiter = this.getRateLimiter();
    const result = await limiter.consume({ groupId, userId, action });

    if (result.allowed) {
      return;
    }

    if (result.reason === 'cooldown') {
      throw new RateLimitError(
        ctx.meta.t('操作冷却中，请稍后重试'),
        'MUSIC_CONTROL_COOLDOWN',
        { retryAfterMs: result.retryAfterMs }
      );
    }

    throw new RateLimitError(
      ctx.meta.t('操作过于频繁，请稍后重试'),
      'MUSIC_CONTROL_RATE_LIMITED',
      { retryAfterMs: result.retryAfterMs }
    );
  }

  /* ------------------------------------------------------------------ *
   * 状态读写
   * ------------------------------------------------------------------ */

  private async restoreRoom(
    groupId: string
  ): Promise<MusicRoomState | null> {
    try {
      const doc = await this.adapter.model.findOne({ groupId }).exec();
      if (!doc) {
        return null;
      }

      return normalizeState(doc.toObject(), groupId, Date.now());
    } catch (error) {
      this.logger.warn('从 Mongo 恢复音乐房间失败', error);
      return null;
    }
  }

  /**
   * 耐久快照（best-effort，revision 单调）
   */
  private async persistRoom(state: MusicRoomState): Promise<void> {
    try {
      const { revision, ...rest } = state;
      const result = await this.adapter.model.updateOne(
        { groupId: state.groupId, revision: { $lt: revision } },
        { $set: rest }
      );

      if (result.matchedCount === 0) {
        await this.adapter.model.updateOne(
          { groupId: state.groupId },
          {
            $set: rest,
            $max: { revision },
            $setOnInsert: { groupId: state.groupId },
          },
          { upsert: true }
        );
      }
    } catch (error) {
      this.logger.warn('音乐房间快照写入失败', error);
    }
  }

  private shouldSnapshot(groupId: string, now: number): boolean {
    const last = this.lastSnapshotAt.get(groupId) ?? 0;
    if (now - last < SNAPSHOT_INTERVAL_MS) {
      return false;
    }

    this.lastSnapshotAt.set(groupId, now);
    return true;
  }

  private async mutateRoom(
    groupId: string,
    mutate: (state: MusicRoomState, now: number) => MusicRoomState | null
  ): Promise<{
    state: MusicRoomState;
    now: number;
    changed: boolean;
    ownerChanged: boolean;
  }> {
    const store = this.getRoomStore();
    let before: MusicRoomState | undefined;

    try {
      const result = await store.mutate(groupId, {
        restore: () => this.restoreRoom(groupId),
        mutate: (state, now) => {
          before = state;
          return mutate(state, now);
        },
      });

      const ownerChanged =
        Boolean(before) && before?.ownerId !== result.state.ownerId;

      if (result.changed) {
        void this.persistRoom(result.state);
      }

      return { ...result, ownerChanged };
    } catch (error) {
      if (error instanceof MusicRoomLockTimeoutError) {
        throw new RateLimitError(error.message, 'MUSIC_ROOM_BUSY', {
          retryAfterMs: 500,
        });
      }

      if (error instanceof MusicRoomConflictError) {
        throw new Errors.MoleculerError(
          error.message,
          503,
          'MUSIC_ROOM_CONFLICT'
        );
      }

      throw error;
    }
  }

  /**
   * 纯读：Redis 缺失时降级读 Mongo 快照
   */
  private async readRoomState(
    groupId: string
  ): Promise<{ state: MusicRoomState; now: number; degraded: boolean }> {
    const { client } = this.resolveNamespace();

    if (!client) {
      const restored = await this.restoreRoom(groupId);
      const now = Date.now();

      return {
        state: restored ?? createInitialState(groupId, now),
        now,
        degraded: true,
      };
    }

    const result = await this.mutateRoom(groupId, () => null);
    return { state: result.state, now: result.now, degraded: false };
  }

  /* ------------------------------------------------------------------ *
   * 通知
   * ------------------------------------------------------------------ */

  private async notifyState(
    ctx: TcPureContext,
    state: MusicRoomState,
    now: number
  ): Promise<void> {
    const ids = memberIds(state);
    if (ids.length === 0) {
      return;
    }

    await this.listcastNotify(
      ctx,
      ids,
      MUSIC_EVENTS.stateUpdate,
      toDto(state, now)
    );
  }

  private async notifyProgress(
    ctx: TcPureContext,
    state: MusicRoomState,
    now: number
  ): Promise<void> {
    const ids = memberIds(state);
    if (ids.length === 0) {
      return;
    }

    const payload: MusicProgressPayload = {
      groupId: state.groupId,
      currentTime: currentTimeOf(state, now),
      isPlaying: state.isPlaying,
    };

    await this.listcastNotify(ctx, ids, MUSIC_EVENTS.progressSync, payload);
  }

  private async notifyOwnerChanged(
    ctx: TcPureContext,
    state: MusicRoomState
  ): Promise<void> {
    const ids = memberIds(state);
    if (ids.length === 0) {
      return;
    }

    const payload: MusicOwnerChangedPayload = {
      groupId: state.groupId,
      ownerId: state.ownerId,
    };

    await this.listcastNotify(ctx, ids, MUSIC_EVENTS.ownerChanged, payload);
  }

  /* ------------------------------------------------------------------ *
   * 定时任务
   * ------------------------------------------------------------------ */

  /**
   * 通过 Redis 租约选举唯一的广播节点；同一节点会持续续期
   */
  private async withLeaderLease(
    fn: (store: MusicRoomStore) => Promise<void>
  ): Promise<void> {
    let store: MusicRoomStore;
    try {
      store = this.getRoomStore();
    } catch {
      return;
    }

    try {
      const isLeader = await store.acquireLeader(this.broker.nodeID, LEADER_TTL_MS);
      if (!isLeader) {
        return;
      }

      await fn(store);
    } catch (error) {
      this.logger.warn('音乐房间租约任务失败', error);
    }
  }

  private async tickProgress(): Promise<void> {
    await this.withLeaderLease(async (store) => {
      const now = await store.now();
      const groupIds = await store.listActive(now);

      for (const groupId of groupIds) {
        const { state, now: readNow } = await store.readRoom(groupId);
        if (!state || !state.isPlaying || state.members.length === 0) {
          continue;
        }

        await this.notifyProgress(this.systemContext(), state, readNow);

        if (this.shouldSnapshot(groupId, readNow)) {
          void this.persistRoom(state);
        }
      }
    });
  }

  /**
   * 断线清理与 owner 交接
   *
   * 在线判定复用 gateway.checkUserOnline（Redis per-user 映射，多标签页安全）
   */
  private async tickPresence(): Promise<void> {
    await this.withLeaderLease(async (store) => {
      const now = await store.now();
      const groupIds = await store.listActive(now);

      for (const groupId of groupIds) {
        const { state } = await store.readRoom(groupId);
        if (!state || state.members.length === 0) {
          continue;
        }

        const ids = memberIds(state);
        let onlineList: boolean[];
        try {
          onlineList = await call(this.systemContext()).isUserOnline(ids);
        } catch (error) {
          this.logger.warn('在线状态查询失败，跳过本次清理', error);
          continue;
        }

        const online: Record<string, boolean> = {};
        ids.forEach((userId, index) => {
          online[userId] = Boolean(onlineList[index]);
        });

        // 全部在线时无需写回
        if (!ids.some((userId) => online[userId] === false)) {
          continue;
        }

        let ownerBefore: string | undefined;
        let removedAny = false;

        const result = await store.mutate(groupId, {
          restore: () => this.restoreRoom(groupId),
          mutate: (current, now2) => {
            ownerBefore = current.ownerId;
            const applied = applyPresence(current, online, now2);
            if (!applied.changed) {
              return null;
            }

            removedAny = applied.removed.length > 0;
            return applied.state;
          },
        });

        if (!result.changed) {
          continue;
        }

        // 仅 offlineMisses 累进时无需打扰客户端
        if (!removedAny) {
          continue;
        }

        const ctx = this.systemContext();
        void this.persistRoom(result.state);

        if (ownerBefore !== result.state.ownerId) {
          await this.notifyOwnerChanged(ctx, result.state);
        }
        await this.notifyState(ctx, result.state, result.now);
        await this.notifyProgress(ctx, result.state, result.now);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 歌单与播放
   * ------------------------------------------------------------------ */

  private sanitizeTrack(
    input: unknown
  ): Omit<MultiplayTrack, 'addedBy' | 'addedAt'> {
    const raw = (input ?? {}) as Record<string, unknown>;
    const id = raw.id == null ? '' : String(raw.id).trim();
    const name = raw.name == null ? '' : String(raw.name).trim();

    if (!id || !name) {
      throw new EntityError('歌曲信息不完整');
    }

    let source: MusicSource | undefined;
    if (raw.source != null && raw.source !== '') {
      const value = String(raw.source);
      if (!MUSIC_SOURCES.includes(value as MusicSource)) {
        throw new EntityError('不支持的音乐源');
      }

      source = value as MusicSource;
    }

    const optionalString = (value: unknown) => {
      if (value == null || value === '') {
        return undefined;
      }

      return String(value);
    };

    const capLyric = (value: unknown) => {
      const text = optionalString(value);
      if (text && text.length > MAX_LYRIC_LENGTH) {
        this.logger.warn('歌词超出长度上限，已忽略');
        return undefined;
      }

      return text;
    };

    return {
      id,
      name,
      artist: optionalString(raw.artist),
      album: optionalString(raw.album),
      picUrl: optionalString(raw.picUrl),
      picId: optionalString(raw.picId),
      lyricId: optionalString(raw.lyricId),
      source,
      lyric: capLyric(raw.lyric),
      tlyric: capLyric(raw.tlyric),
    };
  }

  private async finishMutation(
    ctx: TcContext,
    result: {
      state: MusicRoomState;
      now: number;
      changed: boolean;
      ownerChanged: boolean;
    }
  ): Promise<MusicRoomDto> {
    if (result.changed) {
      if (result.ownerChanged) {
        await this.notifyOwnerChanged(ctx, result.state);
      }

      await this.notifyState(ctx, result.state, result.now);
      await this.notifyProgress(ctx, result.state, result.now);
    }

    return toDto(result.state, result.now);
  }

  private async getState(ctx: TcContext<{ groupId: string }>) {
    const { groupId } = ctx.params;
    await this.ensureMember(ctx, groupId);

    const { state, now, degraded } = await this.readRoomState(groupId);
    return toDto(state, now, degraded);
  }

  private async join(
    ctx: TcContext<{ groupId: string; userName?: string }>
  ) {
    const { groupId } = ctx.params;
    const { userId } = await this.ensureMember(ctx, groupId);

    const nickname =
      ctx.params.userName?.trim() ||
      ctx.meta.user?.nickname ||
      userId;

    const result = await this.mutateRoom(groupId, (state, now) =>
      upsertMember(state, { userId, userName: nickname }, now)
    );

    const dto = toDto(result.state, result.now);

    // 完整状态只发给新加入的成员
    await this.unicastNotify(
      ctx,
      userId,
      MUSIC_EVENTS.stateUpdate,
      dto
    );
    // 全房间只发一次进度同步
    await this.notifyProgress(ctx, result.state, result.now);

    return dto;
  }

  private async leave(ctx: TcContext<{ groupId: string }>) {
    const { groupId } = ctx.params;
    const { userId } = await this.ensureMember(ctx, groupId);

    const result = await this.mutateRoom(groupId, (state, now) =>
      removeMember(state, userId, now)
    );

    return await this.finishMutation(ctx, result);
  }

  private async add(
    ctx: TcContext<{ groupId: string; track: Record<string, unknown> }>
  ) {
    const { groupId } = ctx.params;
    const { userId } = await this.ensureMember(ctx, groupId);
    const track = this.sanitizeTrack(ctx.params.track);

    const result = await this.mutateRoom(groupId, (state, now) =>
      addTrack(state, track, userId, now)
    );

    return await this.finishMutation(ctx, result);
  }

  private async remove(
    ctx: TcContext<{ groupId: string; trackId: string }>
  ) {
    const { groupId, trackId } = ctx.params;
    const { userId } = await this.ensureMember(ctx, groupId);
    await this.checkControlRate(ctx, groupId, userId, 'remove');

    const result = await this.mutateRoom(groupId, (state, now) => {
      this.assertOwner(ctx, state, userId);
      return removeTrack(state, trackId, now);
    });

    return await this.finishMutation(ctx, result);
  }

  private async clear(ctx: TcContext<{ groupId: string }>) {
    const { groupId } = ctx.params;
    const { userId } = await this.ensureMember(ctx, groupId);
    await this.checkControlRate(ctx, groupId, userId, 'clear');

    const result = await this.mutateRoom(groupId, (state, now) => {
      this.assertOwner(ctx, state, userId);
      return clearQueue(state, now);
    });

    return await this.finishMutation(ctx, result);
  }

  private async control(
    ctx: TcContext<{ groupId: string }>,
    action: string,
    mutate: (
      state: MusicRoomState,
      userId: string,
      groupMuteUntil: unknown,
      now: number
    ) => MusicRoomState | null
  ): Promise<MusicRoomDto> {
    const { groupId } = ctx.params;
    const { userId, member } = await this.ensureMember(ctx, groupId);
    await this.checkControlRate(ctx, groupId, userId, action);

    const result = await this.mutateRoom(groupId, (state, now) => {
      this.assertCanControl(ctx, state, userId, member.muteUntil, now);
      const next = mutate(state, userId, member.muteUntil, now);
      if (!next || next === state) {
        return null;
      }

      return touchMember(next, userId, now);
    });

    return await this.finishMutation(ctx, result);
  }

  private play(ctx: TcContext<{ groupId: string }>): Promise<MusicRoomDto> {
    return this.control(ctx, 'play', (state, _userId, _mute, now) =>
      setPlaying(state, true, now)
    );
  }

  private pause(ctx: TcContext<{ groupId: string }>): Promise<MusicRoomDto> {
    return this.control(ctx, 'pause', (state, _userId, _mute, now) =>
      setPlaying(state, false, now)
    );
  }

  private async seek(
    ctx: TcContext<{ groupId: string; time: number }>
  ): Promise<MusicRoomDto> {
    const time = Number(ctx.params.time);
    if (!Number.isFinite(time) || time < 0) {
      throw new EntityError(ctx.meta.t('播放时间无效'));
    }

    return await this.control(ctx, 'seek', (state, _userId, _mute, now) =>
      seekState(state, time, now)
    );
  }

  private next(ctx: TcContext<{ groupId: string }>): Promise<MusicRoomDto> {
    return this.control(ctx, 'next', (state, _userId, _mute, now) =>
      advanceNext(state, now)
    );
  }

  private prev(ctx: TcContext<{ groupId: string }>): Promise<MusicRoomDto> {
    return this.control(ctx, 'prev', (state, _userId, _mute, now) =>
      advancePrev(state, now)
    );
  }

  private async volume(
    ctx: TcContext<{ groupId: string; volume: number }>
  ): Promise<MusicRoomDto> {
    const { groupId, volume } = ctx.params;
    const value = Number(volume);
    if (!Number.isFinite(value)) {
      throw new EntityError(ctx.meta.t('音量无效'));
    }

    const { userId, member } = await this.ensureMember(ctx, groupId);
    await this.checkControlRate(ctx, groupId, userId, 'volume');

    const result = await this.mutateRoom(groupId, (state, now) => {
      this.assertOwner(ctx, state, userId);
      this.assertCanControl(ctx, state, userId, member.muteUntil, now);
      const next = setVolume(state, value, now);

      return next === state ? null : touchMember(next, userId, now);
    });

    return await this.finishMutation(ctx, result);
  }

  private async mute(
    ctx: TcContext<{ groupId: string; memberId: string }>
  ) {
    const { groupId, memberId } = ctx.params;
    const { userId } = await this.ensureMember(ctx, groupId);
    await this.requireManageUser(ctx, groupId);
    await this.checkControlRate(ctx, groupId, userId, 'mute');

    await ctx.call('group.muteGroupMember', {
      groupId,
      memberId,
      muteMs: MUTE_MS,
    });

    const result = await this.mutateRoom(groupId, (state, now) =>
      setMemberMuteUntil(state, memberId, now + MUTE_MS, now)
    );

    return await this.finishMutation(ctx, result);
  }

  /* ------------------------------------------------------------------ *
   * GD Studio 代理
   * ------------------------------------------------------------------ */

  private async runGd<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof GdStudioBusyError) {
        throw new RateLimitError(error.message, 'MUSIC_PROVIDER_BUSY');
      }

      if (error instanceof GdStudioError) {
        throw new Errors.MoleculerError(
          error.message,
          error.code,
          'MUSIC_PROVIDER_ERROR',
          { status: error.status, detail: error.detail, path: error.path }
        );
      }

      throw error;
    }
  }

  private async search(ctx: TcContext<Record<string, unknown>>) {
    return await this.runGd(() => this.getGdClient().search(ctx.params));
  }

  private async url(ctx: TcContext<Record<string, unknown>>) {
    return await this.runGd(() => this.getGdClient().url(ctx.params));
  }

  private async lyric(ctx: TcContext<Record<string, unknown>>) {
    return await this.runGd(() => this.getGdClient().lyric(ctx.params));
  }

  private async pic(ctx: TcContext<Record<string, unknown>>) {
    return await this.runGd(() => this.getGdClient().pic(ctx.params));
  }
}

export default MultiplayService;
