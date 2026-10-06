import { db } from 'tailchat-server-sdk';
import type { MultiplayTrack, RoomMember } from '../services/musicRoomState';

const { getModelForClass, prop, modelOptions, TimeStamps } = db;

/**
 * 音乐房间的持久化快照
 *
 * NOTICE:
 * - Redis 是实时权威状态，本模型只是耐久快照，用于 Redis 缺失时恢复。
 * - 字段与 services/musicRoomState.ts 的 MusicRoomState 对应。
 */
@modelOptions({
  options: {
    customName: 'p_multiplay',
  },
})
export class Multiplay extends TimeStamps implements db.Base {
  _id: db.Types.ObjectId;
  id: string;

  @prop({ required: true, unique: true })
  groupId: string;

  @prop({ default: 0 })
  revision: number;

  @prop({ type: () => [Object], default: () => [] })
  queue: MultiplayTrack[];

  @prop({ type: () => [Object], default: () => [] })
  history: MultiplayTrack[];

  @prop()
  currentTrackId?: string;

  @prop({ type: () => Object })
  currentTrack?: MultiplayTrack;

  /**
   * 当前曲目的基准秒数（配合 playingSince 推导 currentTime）
   */
  @prop({ default: 0 })
  baseTime: number;

  @prop({ default: false })
  isPlaying: boolean;

  /**
   * 播放起点，epoch 毫秒（由 Redis 时钟提供）
   */
  @prop()
  playingSince?: number;

  @prop({ default: 80 })
  volume: number;

  @prop()
  ownerId?: string;

  @prop({ type: () => [Object], default: () => [] })
  members: RoomMember[];

  /**
   * @deprecated 旧版本字段，仅用于迁移，新代码不再读写
   */
  @prop()
  currentTime?: number;
}

export type { MultiplayTrack, RoomMember };
export type MultiplayMember = RoomMember;

export type MultiplayDocument = db.DocumentType<Multiplay>;

const model = getModelForClass(Multiplay);

export type MultiplayModel = typeof model;

export default model;
