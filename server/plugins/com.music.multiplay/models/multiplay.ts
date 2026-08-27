import { db } from 'tailchat-server-sdk';
const { getModelForClass, prop, modelOptions, TimeStamps } = db;

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

  @prop({ type: () => [Object], default: () => [] })
  queue: MultiplayTrack[];

  @prop({ type: () => [Object], default: () => [] })
  history: MultiplayTrack[];

  @prop()
  currentTrackId?: string;

  @prop({ type: () => Object })
  currentTrack?: MultiplayTrack;

  @prop({ default: 0 })
  currentTime: number;

  @prop({ default: false })
  isPlaying: boolean;

  @prop()
  playingSince?: Date;

  @prop({ default: 80 })
  volume: number;

  @prop()
  ownerId?: string;

  @prop({ type: () => [Object], default: () => [] })
  members: MultiplayMember[];

  @prop({ default: 0 })
  revision: number;
}

export interface MultiplayTrack {
  id: string;
  name: string;
  artist?: string;
  picUrl?: string;
  lyric?: string;
  tlyric?: string;
  addedBy: string;
  addedAt: Date;
}

export interface MultiplayMember {
  userId: string;
  userName: string;
  joinedAt: Date;
  muteUntil?: Date;
}

export type MultiplayDocument = db.DocumentType<Multiplay>;

const model = getModelForClass(Multiplay);

export type MultiplayModel = typeof model;

export default model;
