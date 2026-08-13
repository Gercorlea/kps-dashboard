import { Schema, model, models, type Model, type Types } from "mongoose";

// Contadores de rate limiting con expiración automática (§5.6).
export interface IRateLimit {
  _id: Types.ObjectId;
  key: string; // "<bucket>:<ip|ip+email>"
  hits: number;
  expiresAt: Date;
}

const RateLimitSchema = new Schema<IRateLimit>({
  key: { type: String, required: true, unique: true },
  hits: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});

RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimit: Model<IRateLimit> =
  (models.RateLimit as Model<IRateLimit>) ??
  model<IRateLimit>("RateLimit", RateLimitSchema);
