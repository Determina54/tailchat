import { localTrans } from '@capital/common';

export const Translate = {
  musicRoom: localTrans({ 'zh-CN': '音乐房间', 'en-US': 'Music Room' }),
  noTrack: localTrans({ 'zh-CN': '暂无播放', 'en-US': 'No track playing' }),
  play: localTrans({ 'zh-CN': '播放', 'en-US': 'Play' }),
  pause: localTrans({ 'zh-CN': '暂停', 'en-US': 'Pause' }),
  prev: localTrans({ 'zh-CN': '上一首', 'en-US': 'Prev' }),
  next: localTrans({ 'zh-CN': '下一首', 'en-US': 'Next' }),
  clear: localTrans({ 'zh-CN': '清空队列', 'en-US': 'Clear queue' }),
  searchPlaceholder: localTrans({
    'zh-CN': '搜索歌曲、歌手或专辑',
    'en-US': 'Search song, artist or album',
  }),
  search: localTrans({ 'zh-CN': '搜索', 'en-US': 'Search' }),
  add: localTrans({ 'zh-CN': '添加', 'en-US': 'Add' }),
  queue: localTrans({ 'zh-CN': '播放队列', 'en-US': 'Queue' }),
  emptyQueue: localTrans({ 'zh-CN': '队列为空', 'en-US': 'Queue is empty' }),
  lyrics: localTrans({ 'zh-CN': '歌词', 'en-US': 'Lyrics' }),
  noLyrics: localTrans({ 'zh-CN': '暂无歌词', 'en-US': 'No lyrics' }),
  showTranslation: localTrans({
    'zh-CN': '显示翻译',
    'en-US': 'Show translation',
  }),
  volume: localTrans({ 'zh-CN': '音量', 'en-US': 'Volume' }),
  ownerOnlyVolume: localTrans({
    'zh-CN': '仅房主可调整房间音量',
    'en-US': 'Only the owner can change room volume',
  }),
  members: localTrans({ 'zh-CN': '成员', 'en-US': 'Members' }),
  owner: localTrans({ 'zh-CN': '房主', 'en-US': 'Owner' }),
  degraded: localTrans({
    'zh-CN': '实时状态服务暂不可用，当前为只读快照',
    'en-US': 'Realtime state unavailable, showing a read-only snapshot',
  }),
  urlFailed: localTrans({
    'zh-CN': '无法获取播放地址',
    'en-US': 'Unable to fetch the playback url',
  }),
  autoplayBlocked: localTrans({
    'zh-CN': '浏览器阻止了自动播放，请点击播放',
    'en-US': 'Autoplay was blocked, please press play',
  }),
  cooldown: localTrans({
    'zh-CN': '操作过于频繁，请稍后重试',
    'en-US': 'Too many operations, please retry later',
  }),
  roomBusy: localTrans({
    'zh-CN': '音乐房间繁忙，请稍后重试',
    'en-US': 'Music room is busy, please retry later',
  }),
};
