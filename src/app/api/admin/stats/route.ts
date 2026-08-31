import { handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { Chat } from "@/models/Chat";
import { DailyForecast } from "@/models/DailyForecast";
import { PurchaseOrderLine } from "@/models/PurchaseOrderLine";
import { Message } from "@/models/Message";
import { WeeklyForecast } from "@/models/WeeklyForecast";
import { DcStock } from "@/models/DcStock";
import { PharmacyStock } from "@/models/PharmacyStock";
import { Upload } from "@/models/Upload";
import { User } from "@/models/User";
import { DailySale } from "@/models/DailySale";

// Estadísticas del sistema para el módulo de administración (§0).
export async function GET() {
  try {
    await requireModule("admin-estadisticas");
    await connectDB();

    const [usuarios, usuariosActivos, cargas, porStatus, chats, mensajes] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ active: true }),
      Upload.countDocuments(),
      Upload.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      Chat.countDocuments(),
      Message.countDocuments(),
    ]);

    const [ventas, pronosticos, forecast, cedis, farmacia, lineasOc] = await Promise.all([
      DailySale.estimatedDocumentCount(),
      WeeklyForecast.estimatedDocumentCount(),
      DailyForecast.estimatedDocumentCount(),
      DcStock.estimatedDocumentCount(),
      PharmacyStock.estimatedDocumentCount(),
      PurchaseOrderLine.estimatedDocumentCount(),
    ]);

    return ok({
      usuarios: { total: usuarios, activos: usuariosActivos },
      cargas: {
        total: cargas,
        porStatus: Object.fromEntries(porStatus.map((s) => [s._id, s.n])),
      },
      filas: { ventas, pronosticos, forecast, cedis, farmacia, lineasOc },
      chats: { total: chats, mensajes },
    });
  } catch (e) {
    return handleApiError(e);
  }
}
