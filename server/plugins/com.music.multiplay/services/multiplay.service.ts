import {
  TcService,
  TcDbService,
  TcContext,
  NoPermissionError,
  RateLimitError,
  call,
  PERMISSION,
} from 'tailchat-server-sdk';
import type {
  MultiplayDocument,
  MultiplayModel,
  MultiplayTrack,
} from '../models/multiplay';
import { getMusicParams, queryGdStudio } from './gd-studio';

/**
 * multisic
 *
 * 听音乐插件
 */
interface MultiplayService
  extends TcService,
    TcDbService<MultiplayDocument, MultiplayModel> {}
class MultiplayService extends TcService {
  private progressTimer?: ReturnType<typeof setInterval>;

  get serviceName() {
    return 'plugin:com.music.multiplay';
  }

  onInit() {
    this.registerLocalDb(require('../models/multiplay').default);
    this.registerAction('getState', this.getState, {
      params: { groupId: 'string' },
    });
    this.registerAction('join', this.join, {
      params: { groupId: 'string', userName: 'string' },
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
    this.registerAction('mute', this.mute, {
      params: { groupId: 'string', memberId: 'string' },
    });
    this.registerAction('search', this.search, {
      params: { name: 'string', source: { optional: true, type: 'string' } },
    });
    this.registerAction('url', this.url, {
      params: { id: 'string', source: { optional: true, type: 'string' } },
    });
    this.registerAction('lyric', this.lyric, {
      params: { id: 'string', source: { optional: true, type: 'string' } },
    });
    this.registerAction('pic', this.pic, {
      params: { id: 'string', source: { optional: true, type: 'string' } },
    });
    this.registerAction('volume', this.volume, {
      params: { groupId: 'string', volume: 'number' },
    });
  }

  protected onStart() {
    this.progressTimer = setInterval(() => {
      void this.broadcastProgress();
    }, 2000);
  }

  protected onStop() {
    if (this.progressTimer) clearInterval(this.progressTimer);
  }

  private async broadcastProgress() {
    const redis = (this.broker as any).cacher?.client;
    if (!redis) return;
    const leader = await redis.set(
      'music:progress:leader',
      String(this.broker.nodeID),
      'PX',
      2500,
      'NX'
    );
    if (leader !== 'OK') return;
    const rooms = await this.adapter.model.find({ isPlaying: true }).exec();
    await Promise.all(
      rooms.map((room) =>
        this.roomcastNotify(
          { meta: { userId: 'system' } } as TcContext,
          room.groupId,
          'progressSync',
          {
            groupId: room.groupId,
            currentTime: this.withCurrentTime(room).currentTime,
            isPlaying: room.isPlaying,
          }
        )
      )
    );
  }

  private async ensureMember(ctx: TcContext, groupId: string) {
    const group = await call(ctx).getGroupInfo(groupId);
    const userId = String(ctx.meta.userId);
    const member = group.members?.find(
      (item: any) => String(item.userId) === userId
    );
    if (!member) {
      throw new NoPermissionError(ctx.meta.t('不是群组成员'));
    }
    return { group, userId };
  }

  private async getOrCreateRoom(groupId: string) {
    let room = await this.adapter.model.findOne({ groupId }).exec();
    if (!room) {
      room = await this.adapter.model.create({
        groupId,
        queue: [],
        history: [],
        currentTime: 0,
        isPlaying: false,
        volume: 80,
        members: [],
        revision: 0,
      });
    }
    return room;
  }

  private async getState(ctx: TcContext<{ groupId: string }>) {
    await this.ensureMember(ctx, ctx.params.groupId);
    const room = await this.getOrCreateRoom(ctx.params.groupId);
    const state = this.withCurrentTime(room);
    await this.roomcastNotify(ctx, room.groupId, 'progressSync', {
      groupId: room.groupId,
      currentTime: state.currentTime,
      isPlaying: state.isPlaying,
    });
    return state;
  }

  private async join(
    ctx: TcContext<{ groupId: string; userName: string }>
  ) {
    const { groupId, userName } = ctx.params;
    const { userId } = await this.ensureMember(ctx, groupId);
    await call(ctx).joinSocketIORoom([groupId], userId);
    const room = await this.getOrCreateRoom(groupId);
    const existing = room.members.find((item) => item.userId === userId);
    if (!existing) {
      room.members.push({ userId, userName, joinedAt: new Date() });
      if (!room.ownerId) room.ownerId = userId;
      room.revision += 1;
      await room.save();
    }
    await this.roomcastNotify(ctx, groupId, 'stateUpdate', room);
    await this.roomcastNotify(ctx, groupId, 'progressSync', {
      groupId,
      currentTime: this.withCurrentTime(room).currentTime,
      isPlaying: room.isPlaying,
    });
    return room;
  }

  private async leave(ctx: TcContext<{ groupId: string }>) {
    const { groupId } = ctx.params;
    const { userId } = await this.ensureMember(ctx, groupId);
    const room = await this.getOrCreateRoom(groupId);
    room.members = room.members.filter((item) => item.userId !== userId);
    if (room.ownerId === userId) {
      room.ownerId = room.members[0]?.userId;
    }
    room.revision += 1;
    await room.save();
    await this.roomcastNotify(ctx, groupId, 'stateUpdate', room);
    await call(ctx).leaveSocketIORoom([groupId], userId);
    return room;
  }

  private async requireOwner(ctx: TcContext, groupId: string) {
    const { userId } = await this.ensureMember(ctx, groupId);
    const room = await this.getOrCreateRoom(groupId);
    if (room.ownerId !== userId) {
      throw new NoPermissionError(ctx.meta.t('没有操作权限'));
    }
    return { room, userId };
  }

  private async saveRoom(room: MultiplayDocument) {
    this.commitElapsedTime(room);
    room.revision += 1;
    await room.save();
    return room;
  }

  private async saveAndNotify(ctx: TcContext, room: MultiplayDocument) {
    const state = await this.saveRoom(room);
    await this.roomcastNotify(ctx, room.groupId, 'stateUpdate', state);
    const currentState = this.withCurrentTime(state);
    await this.roomcastNotify(ctx, room.groupId, 'progressSync', {
      groupId: room.groupId,
      currentTime: currentState.currentTime,
      isPlaying: currentState.isPlaying,
    });
    return state;
  }

  private async add(
    ctx: TcContext<{ groupId: string; track: MultiplayTrack }>
  ) {
    const { groupId, track } = ctx.params;
    const { userId } = await this.ensureMember(ctx, groupId);
    const room = await this.getOrCreateRoom(groupId);
    room.queue.push({ ...track, addedBy: userId, addedAt: new Date() });
    if (!room.currentTrackId) {
      const next = room.queue.shift();
      room.currentTrackId = next?.id;
      room.currentTrack = next;
      room.currentTime = 0;
      room.isPlaying = Boolean(next);
    }
    return this.saveAndNotify(ctx, room);
  }

  private async remove(ctx: TcContext<{ groupId: string; trackId: string }>) {
    const { room } = await this.requireOwner(ctx, ctx.params.groupId);
    room.queue = room.queue.filter((track) => track.id !== ctx.params.trackId);
    return this.saveAndNotify(ctx, room);
  }

  private async clear(ctx: TcContext<{ groupId: string }>) {
    const { room } = await this.requireOwner(ctx, ctx.params.groupId);
    room.queue = [];
    return this.saveAndNotify(ctx, room);
  }

  private async setPlaying(ctx: TcContext<{ groupId: string }>, playing: boolean) {
    const { room } = await this.ensureControl(ctx, ctx.params.groupId, playing ? 'play' : 'pause');
    this.commitElapsedTime(room);
    room.isPlaying = Boolean(room.currentTrackId) && playing;
    room.playingSince = room.isPlaying ? new Date() : undefined;
    return this.saveAndNotify(ctx, room);
  }

  private play(ctx: TcContext<{ groupId: string }>) {
    return this.setPlaying(ctx, true);
  }

  private pause(ctx: TcContext<{ groupId: string }>) {
    return this.setPlaying(ctx, false);
  }

  private async seek(ctx: TcContext<{ groupId: string; time: number }>) {
    const { room } = await this.ensureControl(ctx, ctx.params.groupId, 'seek');
    this.commitElapsedTime(room);
    if (ctx.params.time < 0 || !Number.isFinite(ctx.params.time)) {
      throw new NoPermissionError(ctx.meta.t('播放时间无效'));
    }
    room.currentTime = ctx.params.time;
    room.playingSince = room.isPlaying ? new Date() : undefined;
    return this.saveAndNotify(ctx, room);
  }

  private async next(ctx: TcContext<{ groupId: string }>) {
    const { room } = await this.ensureControl(ctx, ctx.params.groupId, 'next');
    this.commitElapsedTime(room);
    if (room.currentTrack) {
      room.history.unshift(room.currentTrack);
    }
    const next = room.queue.shift();
    room.currentTrackId = next?.id;
    room.currentTrack = next;
    room.currentTime = 0;
    room.isPlaying = Boolean(next);
    room.playingSince = room.isPlaying ? new Date() : undefined;
    room.history = room.history.slice(0, 50);
    return this.saveAndNotify(ctx, room);
  }

  private async prev(ctx: TcContext<{ groupId: string }>) {
    const { room } = await this.ensureControl(ctx, ctx.params.groupId, 'prev');
    this.commitElapsedTime(room);
    const previous = room.history.shift();
    if (!previous) return room;
    if (room.currentTrack) room.queue.unshift(room.currentTrack);
    room.currentTrackId = previous.id;
    room.currentTrack = previous;
    room.currentTime = 0;
    room.isPlaying = true;
    room.playingSince = new Date();
    return this.saveAndNotify(ctx, room);
  }

  private async ensureControl(ctx: TcContext, groupId: string, action: string) {
    const { userId } = await this.ensureMember(ctx, groupId);
    const room = await this.getOrCreateRoom(groupId);
    const member = room.members.find((item) => item.userId === userId);
    if (member?.muteUntil && member.muteUntil > new Date()) {
      throw new NoPermissionError(ctx.meta.t('当前处于禁播状态'));
    }
    await this.checkControlRate(ctx, groupId, userId, action);
    return { room, userId };
  }

  private async volume(ctx: TcContext<{ groupId: string; volume: number }>) {
    const { room } = await this.ensureMember(ctx, ctx.params.groupId);
    if (!Number.isFinite(ctx.params.volume)) {
      throw new NoPermissionError(ctx.meta.t('音量无效'));
    }
    room.volume = Math.max(0, Math.min(100, ctx.params.volume));
    return this.saveAndNotify(ctx, room);
  }

  private commitElapsedTime(room: MultiplayDocument) {
    if (room.isPlaying && room.playingSince) {
      room.currentTime += Math.max(
        0,
        (Date.now() - room.playingSince.valueOf()) / 1000
      );
      room.playingSince = new Date();
    }
  }

  private async checkControlRate(
    ctx: TcContext,
    groupId: string,
    userId: string,
    action: string
  ) {
    const redis = (this.broker as any).cacher?.client;
    if (!redis) {
      throw new RateLimitError(
        ctx.meta.t('音乐控制服务暂不可用'),
        'MUSIC_CONTROL_UNAVAILABLE'
      );
    }

    const cooldownKey = `music:control:cooldown:${groupId}:${userId}`;
    const windowKey = `music:control:window:${groupId}:${userId}`;
    const script = `
      local cooldown = redis.call('GET', KEYS[1])
      if ARGV[1] == 'play' or ARGV[1] == 'pause' or ARGV[1] == 'seek' then
        if cooldown then return {1, redis.call('PTTL', KEYS[1])} end
      end
      local count = redis.call('INCR', KEYS[2])
      if count == 1 then redis.call('PEXPIRE', KEYS[2], 60000) end
      if count > 10 then return {2, redis.call('PTTL', KEYS[2])} end
      if ARGV[1] == 'play' or ARGV[1] == 'pause' or ARGV[1] == 'seek' then
        redis.call('SET', KEYS[1], '1', 'PX', 5000)
      end
      return {0, 0}
    `;
    const result = await redis.eval(script, 2, cooldownKey, windowKey, action);
    const code = Number(result?.[0]);
    if (code === 1) {
      throw new RateLimitError(ctx.meta.t('操作冷却中，请稍后重试'), 'MUSIC_CONTROL_COOLDOWN', {
        retryAfterMs: Number(result[1]),
      });
    }
    if (code === 2) {
      throw new RateLimitError(ctx.meta.t('操作过于频繁，请稍后重试'), 'MUSIC_CONTROL_RATE_LIMITED', {
        retryAfterMs: Number(result[1]),
      });
    }
  }

  private withCurrentTime(room: MultiplayDocument) {
    this.commitElapsedTime(room);
    if (room.isPlaying && room.playingSince) {
      return {
        ...room.toObject(),
        currentTime:
          room.currentTime + (Date.now() - room.playingSince.valueOf()) / 1000,
      };
    }
    return room;
  }

  private async mute(
    ctx: TcContext<{ groupId: string; memberId: string }>
  ) {
    await this.ensureMember(ctx, ctx.params.groupId);
    const [hasPermission] = await call(ctx).checkUserPermissions(
      ctx.params.groupId,
      String(ctx.meta.userId),
      [PERMISSION.core.manageUser]
    );
    if (!hasPermission) {
      throw new NoPermissionError(ctx.meta.t('没有操作权限'));
    }
    await ctx.call('group.muteGroupMember', {
      groupId: ctx.params.groupId,
      memberId: ctx.params.memberId,
      muteMs: 5 * 60 * 1000,
    });
    const room = await this.getOrCreateRoom(ctx.params.groupId);
    const member = room.members.find(
      (item) => item.userId === ctx.params.memberId
    );
    if (member) {
      member.muteUntil = new Date(Date.now() + 5 * 60 * 1000);
      await this.saveAndNotify(ctx, room);
    }
    return room;
  }

  private search(ctx: TcContext<Record<string, unknown>>) {
    const params = getMusicParams('search', ctx.params);
    return queryGdStudio('search', params.source, params);
  }

  private url(ctx: TcContext<Record<string, unknown>>) {
    const params = getMusicParams('url', ctx.params);
    return queryGdStudio('url', params.source, params);
  }

  private lyric(ctx: TcContext<Record<string, unknown>>) {
    const params = getMusicParams('lyric', ctx.params);
    return queryGdStudio('lyric', params.source, params);
  }

  private pic(ctx: TcContext<Record<string, unknown>>) {
    const params = getMusicParams('pic', ctx.params);
    return queryGdStudio('pic', params.source, params);
  }
}

export default MultiplayService;
