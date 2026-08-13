import { Schema, model, models, type Model, type Types } from "mongoose";

export interface IMensaje {
  _id: Types.ObjectId;
  chatId: Types.ObjectId;
  userId: Types.ObjectId;
  role: "user" | "assistant";
  content: string;
  // Uso del modelo; solo en mensajes del asistente. Opcionales: los mensajes
  // guardados antes de medir el consumo no los tienen.
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  // Llamadas a herramientas de esa respuesta. Es lo que permite reconstruir
  // la tarjeta de reporte al recargar, y deja la traza de qué se consultó.
  tools?: Array<{ name: string; args?: unknown; result?: unknown }>;
  createdAt: Date;
}

const MensajeSchema = new Schema<IMensaje>(
  {
    chatId: { type: Schema.Types.ObjectId, ref: "Chat", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    model: { type: String },
    inputTokens: { type: Number },
    outputTokens: { type: Number },
    costUSD: { type: Number },
    tools: {
      type: [
        new Schema(
          {
            name: { type: String, required: true },
            args: { type: Schema.Types.Mixed },
            result: { type: Schema.Types.Mixed },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

MensajeSchema.index({ chatId: 1, createdAt: 1 });

export const Mensaje: Model<IMensaje> =
  (models.Mensaje as Model<IMensaje>) ?? model<IMensaje>("Mensaje", MensajeSchema);
