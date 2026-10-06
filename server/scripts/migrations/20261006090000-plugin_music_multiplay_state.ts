import type { Db, MongoClient } from 'mongodb';

/**
 * 音乐房间状态模型迁移
 *
 * 旧结构：currentTime(number) + playingSince(Date)，members 只有 joinedAt
 * 新结构：baseTime(number) + playingSince(number, epoch ms)
 *
 * NOTICE: 该插件此前未进入默认安装列表，线上通常没有数据，本迁移做安全空转。
 */
module.exports = {
  async up(db: Db, client: MongoClient) {
    const collectionNames = (await db.collections()).map(
      (c) => c.collectionName
    );
    if (!collectionNames.includes('p_multiplays')) {
      console.log('not init `p_multiplays`, ignored.');
      return;
    }

    const collection = db.collection('p_multiplays');
    const list = await collection.find({}).toArray();
    console.log(`待处理音乐房间记录: ${list.length} 条`);

    for (const item of list) {
      const legacyCurrentTime =
        typeof item.currentTime === 'number' ? item.currentTime : undefined;
      const hasBaseTime = typeof item.baseTime === 'number';

      const baseTime = hasBaseTime
        ? item.baseTime
        : legacyCurrentTime ?? 0;

      let playingSince: number | undefined;
      if (item.playingSince instanceof Date) {
        playingSince = item.playingSince.valueOf();
      } else if (typeof item.playingSince === 'number') {
        playingSince = item.playingSince;
      }

      const members = Array.isArray(item.members)
        ? item.members.map((member: Record<string, unknown>) => ({
            ...member,
            joinedAt:
              member.joinedAt instanceof Date
                ? member.joinedAt.valueOf()
                : typeof member.joinedAt === 'number'
                ? member.joinedAt
                : Date.now(),
            lastSeenAt:
              typeof member.lastSeenAt === 'number'
                ? member.lastSeenAt
                : Date.now(),
            offlineMisses:
              typeof member.offlineMisses === 'number'
                ? member.offlineMisses
                : 0,
            muteUntil:
              member.muteUntil instanceof Date
                ? member.muteUntil.valueOf()
                : typeof member.muteUntil === 'number'
                ? member.muteUntil
                : undefined,
          }))
        : [];

      const normalizeTracks = (tracks: unknown) =>
        Array.isArray(tracks)
          ? tracks.map((track: Record<string, unknown>) => ({
              ...track,
              addedAt:
                track.addedAt instanceof Date
                  ? track.addedAt.valueOf()
                  : typeof track.addedAt === 'number'
                  ? track.addedAt
                  : Date.now(),
            }))
          : [];

      await collection.updateOne(
        { _id: item._id },
        {
          $set: {
            baseTime,
            playingSince,
            members,
            queue: normalizeTracks(item.queue),
            history: normalizeTracks(item.history),
            revision: typeof item.revision === 'number' ? item.revision : 0,
            volume: typeof item.volume === 'number' ? item.volume : 80,
          },
          $unset: { currentTime: '' },
        }
      );
      console.log('已迁移:', item._id);
    }
  },

  async down(db: Db, client: MongoClient) {
    const collectionNames = (await db.collections()).map(
      (c) => c.collectionName
    );
    if (!collectionNames.includes('p_multiplays')) {
      return;
    }

    const collection = db.collection('p_multiplays');
    const list = await collection.find({}).toArray();

    for (const item of list) {
      await collection.updateOne(
        { _id: item._id },
        {
          $set: {
            currentTime: typeof item.baseTime === 'number' ? item.baseTime : 0,
            playingSince:
              typeof item.playingSince === 'number'
                ? new Date(item.playingSince)
                : undefined,
          },
        }
      );
    }
  },
};
