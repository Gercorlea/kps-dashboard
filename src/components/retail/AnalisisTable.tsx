import { memo } from "react";
import { formatearCelda, formatearEntero } from "@/lib/retail/analisis/formato";
import type { FilaCruda, MetaColumna } from "@/lib/retail/analisis/tipos";

// Un archivo muy ancho no aporta nada tras las primeras decenas de columnas y
// multiplica el DOM: se recorta y se avisa.
export const MAX_COLUMNAS = 60;

interface Props {
  columnas: MetaColumna[];
  filasVisibles: FilaCruda[];
  totalFilas: number;
  hoja: string;
  filaEncabezado: number;
}

function AnalisisTableBase({
  columnas,
  filasVisibles,
  totalFilas,
  hoja,
  filaEncabezado,
}: Props) {
  const visibles = columnas.slice(0, MAX_COLUMNAS);

  // A diferencia de SheetTable, aquí no hay paginación servidor: el dataset
  // vive en memoria del navegador. Se muestran 100 filas porque 15k x 20
  // columnas son 300 mil <td>, suficientes para congelar la pestaña; las
  // gráficas sí agregan sobre el total y la leyenda lo deja explícito.
  const leyenda = [
    `Mostrando ${formatearEntero(filasVisibles.length)} de ${formatearEntero(totalFilas)} filas`,
    `hoja «${hoja}»`,
    // Se expone la detección de encabezado para que un acierto dudoso sea
    // visible en pantalla en vez de silencioso.
    filaEncabezado >= 0
      ? `encabezado en la fila ${filaEncabezado + 1}`
      : "sin encabezado detectado",
    columnas.length > MAX_COLUMNAS
      ? `mostrando ${MAX_COLUMNAS} de ${formatearEntero(columnas.length)} columnas`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="cr-panel">
      <header className="cr-panel__head">
        <h3 className="cr-h3">Datos en crudo</h3>
        <span className="cr-small">{leyenda}</span>
      </header>

      <div className="cr-table-scroll" style={{ maxHeight: "32rem", overflowY: "auto" }}>
        <table className="cr-table">
          <thead>
            <tr>
              {visibles.map((col) => (
                <th
                  key={col.indice}
                  scope="col"
                  className={col.tipo === "numero" ? "num" : undefined}
                  title={col.nombre}
                >
                  {col.nombre}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filasVisibles.map((fila, i) => (
              <tr key={i}>
                {visibles.map((col) => {
                  const texto = formatearCelda(fila[col.indice]);
                  const clases =
                    col.tipo === "numero" ? "num" : col.tipo === "fecha" ? "cr-mono" : undefined;
                  return (
                    <td
                      key={col.indice}
                      className={clases}
                      title={texto}
                      style={{ maxWidth: "24rem", whiteSpace: "nowrap" }}
                    >
                      <span className="block truncate">{texto || "—"}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Cambiar un selector de gráficas no debe rerenderizar la tabla.
export const AnalisisTable = memo(AnalisisTableBase);
