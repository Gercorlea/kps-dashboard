// TEMPORAL — sólo para verificar el analizador en navegador sin sesión.
// Se elimina al terminar la verificación.
import { AnalisisExcel } from "@/components/retail/AnalisisExcel";

export default function QaPage() {
  return (
    <div className="cr-shell__main">
      <div className="cr-page-content">
        <AnalisisExcel />
      </div>
    </div>
  );
}
