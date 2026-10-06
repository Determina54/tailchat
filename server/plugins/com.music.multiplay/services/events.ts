import type { MusicRoomDto } from './musicRoomState';

/**
 * 服务名（同时是 socket 事件前缀）
 */
export const MUSIC_SERVICE_NAME = 'plugin:com.music.multiplay';

/**
 * 事件名的单一来源
 *
 * NOTICE:
 * - 服务端通过 TcService.generateNotifyEventName() 生成，实际下发的事件名为
 *   `notify:plugin:com.music.multiplay.<event>`。
 * - 客户端 AppSocket.listen() 会自行补上 `notify:` 前缀，因此前端必须订阅
 *   `plugin:com.music.multiplay.<event>`。
 *   前端常量见 web/plugins/com.music.multiplay/src/events.ts，两者必须保持一致。
 */
export const MUSIC_EVENTS = {
  stateUpdate: 'stateUpdate',
  progressSync: 'progressSync',
  ownerChanged: 'ownerChanged',
} as const;

export type MusicEventName =
  (typeof MUSIC_EVENTS)[keyof typeof MUSIC_EVENTS];

/**
 * 客户端订阅使用的事件名
 */
export function toClientEventName(event: MusicEventName): string {
  return `${MUSIC_SERVICE_NAME}.${event}`;
}

export interface MusicProgressPayload {
  groupId: string;
  currentTime: number;
  isPlaying: boolean;
}

export interface MusicOwnerChangedPayload {
  groupId: string;
  ownerId?: string;
}

export type MusicStateUpdatePayload = MusicRoomDto;
