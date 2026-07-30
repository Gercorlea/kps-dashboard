import { handleApiError, ok } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { Chat } from "@/models/Chat";
import { ForecastDiario } from "@/models/ForecastDiario";
import { LineaOC } from "@/models/LineaOC";
import { Mensaje } from "@/models/Mensaje";
import { PronosticoSemanal } from "@/models/PronosticoSemanal";
import { StockCedis } from "@/models/StockCedis";
import { StockFarmacia } from "@/models/StockFarmacia";
import { Upload } from "@/models/Upload";
import { User } from "@/models/User";
import { VentaDiaria } from "@/models/VentaDiaria";

// Estadísticas del sistema para el módulo de administración (§0).
export async function GET() {
  try {
    await requireModule("admin");
    await connectDB();

    const [usuarios, usuariosActivos, cargas, porStatus, chats, mensajes] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ active: true }),
      Upload.countDocuments(),
      Upload.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      Chat.countDocuments(),
      Mensaje.countDocuments(),
    ]);

    const [ventas, pronosticos, forecast, cedis, farmacia, lineasOc] = await Promise.all([
      VentaDiaria.estimatedDocumentCount(),
      PronosticoSemanal.estimatedDocumentCount(),
      ForecastDiario.estimatedDocumentCount(),
      StockCedis.estimatedDocumentCount(),
      StockFarmacia.estimatedDocumentCount(),
      LineaOC.estimatedDocumentCount(),
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
