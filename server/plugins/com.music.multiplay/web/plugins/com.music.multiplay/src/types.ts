/**
 * 前端使用的数据结构
 *
 * NOTICE: 必须与 server/plugins/com.music.multiplay/services/musicRoomState.ts
 * 中的 MusicRoomDto / MultiplayTrack / RoomMember 保持一致。
 */

export interface MusicTrack {
  id: string;
  name: string;
  artist?: string;
  album?: string;
  picUrl?: string;
  picId?: string;
  lyricId?: string;
  source?: string;
  lyric?: string;
  tlyric?: string;
  addedBy?: string;
  addedAt?: number;
}

export interface MusicRoomMember {
  userId: string;
  userName: string;
  joinedAt: number;
  muteUntil?: number;
}

export interface MusicRoomState {
  groupId: string;
  revision: number;
  queue: MusicTrack[];
  history: MusicTrack[];
  currentTrackId?: string;
  currentTrack?: MusicTrack;
  currentTime: number;
  isPlaying: boolean;
  volume: number;
  ownerId?: string;
  members: MusicRoomMember[];
  /**
   * Redis 不可用时服务端降级读 Mongo 快照
   */
  degraded?: boolean;
}

export interface MusicSearchResult {
  id: string;
  name: string;
  artist?: string;
  album?: string;
  picId?: string;
  lyricId?: string;
  source: string;
}

export function createEmptyRoomState(groupId: string): MusicRoomState {
  return {
    groupId,
    revision: 0,
    queue: [],
    history: [],
    currentTime: 0,
    isPlaying: false,
    volume: 80,
    members: [],
  };
}

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(volume)));
}
