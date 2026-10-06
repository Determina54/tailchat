import fs from 'fs';
import path from 'path';
import {
  MUSIC_EVENTS,
  MUSIC_SERVICE_NAME,
  toClientEventName,
} from '../services/events';

const FRONTEND_EVENTS_FILE = path.resolve(
  __dirname,
  '../web/plugins/com.music.multiplay/src/events.ts'
);

describe('music events 契约', () => {
  test('服务名为 plugin:com.music.multiplay', () => {
    expect(MUSIC_SERVICE_NAME).toBe('plugin:com.music.multiplay');
  });

  test('客户端事件名不带 notify: 前缀（AppSocket.listen 会自行添加）', () => {
    expect(toClientEventName(MUSIC_EVENTS.stateUpdate)).toBe(
      'plugin:com.music.multiplay.stateUpdate'
    );
    expect(toClientEventName(MUSIC_EVENTS.progressSync)).toBe(
      'plugin:com.music.multiplay.progressSync'
    );
    expect(toClientEventName(MUSIC_EVENTS.ownerChanged)).toBe(
      'plugin:com.music.multiplay.ownerChanged'
    );
  });

  test('前端常量与服务端保持一致且不重复 notify: 前缀', () => {
    const source = fs.readFileSync(FRONTEND_EVENTS_FILE, 'utf8');

    for (const event of Object.values(MUSIC_EVENTS)) {
      expect(source).toContain(`plugin:com.music.multiplay.${event}`);
      expect(source).not.toContain(`notify:plugin:com.music.multiplay.${event}`);
    }
  });
});
