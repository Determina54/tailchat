/**
 * Socket 事件名
 *
 * NOTICE:
 * - 服务端 TcService.generateNotifyEventName() 实际下发的事件名是
 *   `notify:plugin:com.music.multiplay.<event>`。
 * - 客户端 AppSocket.listen() 会自行补上 `notify:` 前缀，因此这里**不能**带前缀，
 *   否则会监听 `notify:notify:...` 而永不触发。
 * - 必须与 server/plugins/com.music.multiplay/services/events.ts 保持一致。
 */

export const MUSIC_SOCKET_EVENTS = {
  stateUpdate: 'plugin:com.music.multiplay.stateUpdate',
  progressSync: 'plugin:com.music.multiplay.progressSync',
  ownerChanged: 'plugin:com.music.multiplay.ownerChanged',
} as const;

export interface MusicProgressPayload {
  groupId: string;
  currentTime: number;
  isPlaying: boolean;
}

export interface MusicOwnerChangedPayload {
  groupId: string;
  ownerId?: string;
}
