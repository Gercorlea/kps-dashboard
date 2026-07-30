import { Schema, model, models, type Model, type Types } from "mongoose";

// Conversaciones de Cronos IA, scopeadas por usuario (§9.2).
export interface IChat {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  titulo: string;
  createdAt: Date;
  updatedAt: Date;
}

const ChatSchema = new Schema<IChat>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    titulo: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

ChatSchema.index({ userId: 1, updatedAt: -1 });

export const Chat: Model<IChat> =
  (models.Chat as Model<IChat>) ?? model<IChat>("Chat", ChatSchema);
