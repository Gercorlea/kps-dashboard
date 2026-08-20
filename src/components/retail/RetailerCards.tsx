import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { fmtFecha, fmtMes, fmtNum, fmtPct } from "@/components/lib/fmt";
import { Delta } from "@/components/retail/viz";
import { colorRetailer } from "@/lib/retail/retailers";
import type { DetalleRetailer, PuntoVentas } from "@/lib/retail/stats";

// La portada del módulo: una card por retailer en vez de una fila de tabla.
//
// La fila daba ocho columnas del mismo peso y ninguna identidad: había que
// leerla de izquierda a derecha para saber de quién era. La card pone delante
// lo que se busca al entrar —de quién, cuánto y hacia dónde va— y deja el
// detalle (artículos, reportes, periodo) abajo, donde no estorba.
//
// Es un componente de servidor: sólo `Delta` cruza al cliente, y ya viaja en el
// bundle de la página por la gráfica. El sparkline es SVG plano, sin recharts:
// doce puntos sin ejes ni tooltip no justifican la librería, y la portada es la
// ruta que más conviene que llegue ligera.

/** Caja del sparkline. El ancho se estira; estas son coordenadas del viewBox. */
const SPARK_W = 100;
const SPARK_H = 32;
/** Aire arriba para que el pico no se coma el trazo contra el borde. */
const SPARK_TOP = 4;
const SPARK_BASE = 30;
/** Y a los lados: el trazo del primer y del último mes es lo que se recortaría. */
const SPARK_PAD = 1.5;

/** Unidades del retailer mes a mes, con null en los meses sin reporte. */
function serieDe(serie: PuntoVentas[], id: string): Array<number | null> {
  return serie.map((p) => (typeof p[id] === "number" ? (p[id] as number) : null));
}

/**
 * Variación del último mes con venta contra el anterior, con el mismo criterio
 * que el KPI de la página: el mes en curso suele estar a medias o sin reporte,
 * y compararlo daría una caída que no ocurrió.
 */
function variacion(
  serie: PuntoVentas[],
  valores: Array<number | null>
): { fraccion: number; titulo: string } | null {
  let i = -1;
  for (let k = valores.length - 1; k >= 0; k--) {
    if ((valores[k] ?? 0) > 0) {
      i = k;
      break;
    }
  }
  const previo = i > 0 ? (valores[i - 1] ?? 0) : 0;
  if (i <= 0 || previo <= 0) return null;
  return {
    fraccion: ((valores[i] as number) - previo) / previo,
    titulo: `${fmtMes(serie[i].periodo)} contra ${fmtMes(serie[i - 1].periodo)}`,
  };
}

function Sparkline({ valores, color }: { valores: Array<number | null>; color: string }) {
  const max = Math.max(0, ...valores.map((v) => v ?? 0));
  if (max <= 0) return null;

  const n = valores.length;
  const px = (i: number) =>
    n <= 1 ? SPARK_W / 2 : SPARK_PAD + (i / (n - 1)) * (SPARK_W - 2 * SPARK_PAD);
  const py = (v: number) => SPARK_BASE - (v / max) * (SPARK_BASE - SPARK_TOP);

  // Un mes sin reporte no es un mes sin venta (lo mismo que en la gráfica
  // grande): la línea se corta ahí en vez de caer al suelo, así que se dibuja
  // un tramo por racha de meses con dato.
  const tramos: Array<Array<{ x: number; y: number }>> = [];
  let actual: Array<{ x: number; y: number }> = [];
  valores.forEach((v, i) => {
    if (v === null) {
      if (actual.length) tramos.push(actual);
      actual = [];
      return;
    }
    actual.push({ x: px(i), y: py(v) });
  });
  if (actual.length) tramos.push(actual);

  const ultimo = tramos.at(-1)?.at(-1) ?? null;

  return (
    <div className="cr-rcard__spark">
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
        {tramos.map((puntos, i) => {
          const linea = puntos.map((p, k) => `${k === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
          const area = `M${puntos[0].x} ${SPARK_BASE} ${puntos
            .map((p) => `L${p.x} ${p.y}`)
            .join(" ")} L${puntos.at(-1)!.x} ${SPARK_BASE} Z`;
          return (
            <g key={i}>
              {puntos.length > 1 ? <path d={area} fill={color} fillOpacity={0.1} /> : null}
              {/* Un mes suelto se dibuja como punto: un `L` al mismo punto con
                  la punta redonda. Sin esto, una racha de uno desaparece. */}
              <path
                d={puntos.length > 1 ? linea : `M${puntos[0].x} ${puntos[0].y} L${puntos[0].x} ${puntos[0].y}`}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                // El viewBox se estira a lo ancho: sin esto el trazo se
                // ensancharía con la card.
                vectorEffect="non-scaling-stroke"
              />
            </g>
          );
        })}
      </svg>
      {ultimo ? (
        <span
          aria-hidden="true"
          className="cr-rcard__punta"
          style={{
            left: `${ultimo.x}%`,
            top: `${(ultimo.y / SPARK_H) * 100}%`,
            background: color,
          }}
        />
      ) : null}
    </div>
  );
}

function RetailerCard({ r, serie }: { r: DetalleRetailer; serie: PuntoVentas[] }) {
  const color = colorRetailer(r.id);
  const conDatos = r.reportes > 0;
  const valores = serieDe(serie, r.id);
  const delta = conDatos ? variacion(serie, valores) : null;

  return (
    <article
      className={`cr-rcard${conDatos ? "" : " cr-rcard--vacio"}`}
      style={{ "--cr-rcard-color": color } as React.CSSProperties}
    >
      <div className="cr-rcard__head">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0"
          style={{ background: color, borderRadius: "var(--cr-r-xs)" }}
        />
        {/* El enlace del nombre cubre la card entera (ver .cr-rcard__link):
            se puede hacer clic en cualquier parte sin repetir el enlace. */}
        <Link href={`/retail/${r.id}`} className="cr-rcard__link cr-rcard__nombre">
          {r.nombre}
        </Link>
        <ChevronRight className="cr-rcard__ir" size={16} strokeWidth={1.75} aria-hidden="true" />
      </div>

      {conDatos ? (
        <>
          <div>
            <div className="cr-rcard__cifra">
              <span className="cr-rcard__label">Importe</span>
              <span className="cr-rcard__part">{fmtPct(r.participacion)} del total</span>
            </div>
            <div className="cr-rcard__valor">{fmtNum(r.importe)}</div>
            <div
              className="cr-rcard__barra"
              role="progressbar"
              aria-label="Participación en el importe total"
              aria-valuenow={Math.round((r.participacion ?? 0) * 100)}
            >
              <span style={{ width: `${Math.min(100, (r.participacion ?? 0) * 100)}%` }} />
            </div>
          </div>

          <div>
            <div className="cr-rcard__cifra">
              <span className="cr-rcard__label">Unidades por mes · 12 m</span>
              {delta ? (
                <span title={delta.titulo}>
                  <Delta fraccion={delta.fraccion} texto={fmtPct(delta.fraccion, true)} />
                </span>
              ) : null}
            </div>
            <Sparkline valores={valores} color={color} />
          </div>

          <dl className="cr-rcard__cifras">
            <div>
              <dt>Unidades</dt>
              <dd>{fmtNum(r.unidades)}</dd>
            </div>
            <div>
              <dt>Artículos</dt>
              <dd>{fmtNum(r.articulos)}</dd>
            </div>
            <div>
              <dt>Reportes</dt>
              <dd>{fmtNum(r.reportes)}</dd>
            </div>
          </dl>

          <div className="cr-rcard__pie">
            <span>
              {fmtFecha(r.desde)} — {fmtFecha(r.hasta)}
            </span>
            <span title={r.ultimoArchivo ?? undefined}>Últ. {fmtFecha(r.ultimoReporte)}</span>
          </div>
        </>
      ) : (
        <div className="cr-rcard__vacio">
          <p>Todavía no hay reportes guardados.</p>
          <p>Ábrelo y carga su Excel con «Cargar un Excel».</p>
        </div>
      )}
    </article>
  );
}

export function RetailerCards({
  retailers,
  serie,
}: {
  retailers: DetalleRetailer[];
  serie: PuntoVentas[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {retailers.map((r) => (
        <RetailerCard key={r.id} r={r} serie={serie} />
      ))}
    </div>
  );
}
