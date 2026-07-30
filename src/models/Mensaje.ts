import { Schema, model, models, type Model, type Types } from "mongoose";

export interface IMensaje {
  _id: Types.ObjectId;
  chatId: Types.ObjectId;
  userId: Types.ObjectId;
  rol: "user" | "assistant";
  contenido: string;
  createdAt: Date;
}

const MensajeSchema = new Schema<IMensaje>(
  {
    chatId: { type: Schema.Types.ObjectId, ref: "Chat", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    rol: { type: String, enum: ["user", "assistant"], required: true },
    contenido: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

MensajeSchema.index({ chatId: 1, createdAt: 1 });

export const Mensaje: Model<IMensaje> =
  (models.Mensaje as Model<IMensaje>) ?? model<IMensaje>("Mensaje", MensajeSchema);
