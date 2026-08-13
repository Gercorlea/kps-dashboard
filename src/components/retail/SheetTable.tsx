"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtFecha, fmtNum, fmtPct } from "@/components/lib/fmt";
import { Paginacion } from "@/components/dashboard/Paginacion";

type TipoCol = "texto" | "num" | "date" | "pct";

interface Columna {
  key: string;
  etiqueta: string;
  tipo: TipoCol;
  sticky?: 1 | 2;
  ordenable?: boolean;
}

// Columnas por hoja (§7.2). Sticky: SKU + descripción en desktop (§4.5).
const COLUMNAS: Record<string, Columna[]> = {
  VENTAS: [
    { key: "sku", etiqueta: "SKU", tipo: "texto", sticky: 1, ordenable: true },
    { key: "description", etiqueta: "Descripción", tipo: "texto", sticky: 2 },
    { key: "date", etiqueta: "Fecha", tipo: "date", ordenable: true },
    { key: "storeCode", etiqueta: "Tienda", tipo: "texto", ordenable: true },
    { key: "storeName", etiqueta: "Farmacia", tipo: "texto" },
    { key: "brand", etiqueta: "Marca", tipo: "texto", ordenable: true },
    { key: "units", etiqueta: "Unidades", tipo: "num", ordenable: true },
  ],
  PRONOSTICOS: [
    { key: "sku", etiqueta: "SKU", tipo: "texto", sticky: 1, ordenable: true },
    { key: "description", etiqueta: "Descripción", tipo: "texto", sticky: 2 },
    { key: "weekStart", etiqueta: "Semana", tipo: "date", ordenable: true },
    { key: "storeCode", etiqueta: "Tienda", tipo: "texto", ordenable: true },
    { key: "brand", etiqueta: "Marca", tipo: "texto", ordenable: true },
    { key: "value", etiqueta: "Pronóstico", tipo: "num", ordenable: true },
  ],
  FC_Mean: [
    { key: "sku", etiqueta: "SKU", tipo: "texto", sticky: 1, ordenable: true },
    { key: "description", etiqueta: "Descripción", tipo: "texto", sticky: 2 },
    { key: "date", etiqueta: "Fecha", tipo: "date", ordenable: true },
    { key: "storeCode", etiqueta: "Tienda", tipo: "texto", ordenable: true },
    { key: "brand", etiqueta: "Marca", tipo: "texto", ordenable: true },
    { key: "value", etiqueta: "Forecast", tipo: "num", ordenable: true },
  ],
  CEDIS: [
    { key: "sku", etiqueta: "SKU", tipo: "texto", sticky: 1, ordenable: true },
    { key: "description", etiqueta: "Descripción", tipo: "texto", sticky: 2 },
    { key: "brand", etiqueta: "Marca", tipo: "texto", ordenable: true },
    { key: "realAvailabilityDC", etiqueta: "Disp. real CD", tipo: "num", ordenable: true },
    { key: "inTransit", etiqueta: "Tránsitos", tipo: "num" },
    { key: "withoutAppointment", etiqueta: "Sin cita", tipo: "num" },
    { key: "planCharacteristic", etiqueta: "Plan", tipo: "texto" },
    { key: "minimum", etiqueta: "Mínimo", tipo: "num" },
    { key: "coverage", etiqueta: "Cobertura", tipo: "num" },
    { key: "reorderPoint", etiqueta: "Punto pedido", tipo: "num" },
    { key: "targetStock", etiqueta: "Stock objetivo", tipo: "num" },
  ],
  "Fill Rate": [
    { key: "purchaseDoc", etiqueta: "OC", tipo: "texto", sticky: 1, ordenable: true },
    { key: "description", etiqueta: "Descripción", tipo: "texto", sticky: 2 },
    { key: "sku", etiqueta: "SKU", tipo: "texto", ordenable: true },
    { key: "brand", etiqueta: "Marca", tipo: "texto" },
    { key: "orderDate", etiqueta: "Pedido", tipo: "date" },
    { key: "deliveryDate", etiqueta: "Entrega", tipo: "date" },
    { key: "allocatedQty", etiqueta: "Pedidas", tipo: "num" },
    { key: "deliveredQty", etiqueta: "Entregadas", tipo: "num" },
    { key: "fillRate", etiqueta: "Fill rate", tipo: "pct", ordenable: true },
    { key: "poStatus", etiqueta: "Estatus", tipo: "texto", ordenable: true },
    { key: "buyer", etiqueta: "Negociador", tipo: "texto", ordenable: true },
  ],
  "Inv Farma": [
    { key: "sku", etiqueta: "SKU", tipo: "texto", sticky: 1, ordenable: true },
    { key: "description", etiqueta: "Descripción", tipo: "texto", sticky: 2 },
    { key: "storeCode", etiqueta: "Tienda", tipo: "texto", ordenable: true },
    { key: "storeName", etiqueta: "Farmacia", tipo: "texto" },
    { key: "brand", etiqueta: "Marca", tipo: "texto" },
    { key: "unrestrictedStock", etiqueta: "Libre util.", tipo: "num", ordenable: true },
    { key: "pharmacyInTransit", etiqueta: "Tránsito", tipo: "num" },
    { key: "targetStock", etiqueta: "Stock obj.", tipo: "num" },
    { key: "reorderPoint", etiqueta: "Punto pedido", tipo: "num" },
    { key: "inventoryLevel", etiqueta: "Nivel inv.", tipo: "num", ordenable: true },
  ],
};

function celda(value: unknown, tipo: TipoCol): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (tipo) {
    case "num":
      return fmtNum(value as number);
    case "pct":
      return fmtPct(value as number);
    case "date":
      return fmtFecha(String(value));
    default:
      return String(value);
  }
}

export function SheetTable({ uploadId, hojas }: { uploadId: string; hojas: string[] }) {
  const disponibles = useMemo(
    () => hojas.filter((h) => COLUMNAS[h] !== undefined),
    [hojas]
  );
  const [sheet, setHoja] = useState(disponibles[0] ?? "VENTAS");
  const [filas, setFilas] = useState<Record<string, unknown>[]>([]);
  const [pagina, setPagina] = useState(1);
  const [paginas, setPaginas] = useState(1);
  const [total, setTotal] = useState(0);
  const [buscar, setBuscar] = useState("");
  const [brand, setMarca] = useState("");
  const [tienda, setTienda] = useState("");
  const [marcas, setMarcas] = useState<string[]>([]);
  const [tiendas, setTiendas] = useState<string[]>([]);
  const [orden, setOrden] = useState<string | null>(null);
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const columnas = COLUMNAS[sheet] ?? [];

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const q = new URLSearchParams({ sheet, page: String(pagina), dir });
      if (buscar) q.set("buscar", buscar);
      if (brand) q.set("brand", brand);
      if (tienda) q.set("tienda", tienda);
      if (orden) q.set("orden", orden);
      const r = await api<{
        filas: Record<string, unknown>[];
        total: number;
        paginas: number;
        marcas: string[];
        tiendas: string[];
      }>(`/api/retail/uploads/${uploadId}/rows?${q.toString()}`);
      setFilas(r.filas);
      setTotal(r.total);
      setPaginas(r.paginas);
      setMarcas(r.marcas);
      setTiendas(r.tiendas);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "No se pudieron cargar las filas");
    } finally {
      setCargando(false);
    }
  }, [uploadId, sheet, pagina, buscar, brand, tienda, orden, dir]);

  useEffect(() => {
    // fetch-on-mount: el flag de carga se activa al iniciar la petición
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void cargar();
  }, [cargar]);

  function cambiarHoja(h: string) {
    setHoja(h);
    setPagina(1);
    setBuscar("");
    setMarca("");
    setTienda("");
    setOrden(null);
    setDir("desc");
  }

  function ordenarPor(col: Columna) {
    if (!col.ordenable) return;
    if (orden === col.key) {
      setDir(dir === "asc" ? "desc" : "asc");
    } else {
      setOrden(col.key);
      setDir("desc");
    }
    setPagina(1);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="cr-segment self-start overflow-x-auto" role="tablist">
        {disponibles.map((h) => (
          <button
            key={h}
            type="button"
            role="tab"
            aria-selected={h === sheet}
            className={`cr-segment__item${h === sheet ? " cr-segment__item--active" : ""}`}
            onClick={() => cambiarHoja(h)}
          >
            {h}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          className="cr-input max-w-xs"
          placeholder="Buscar SKU, descripción, farmacia…"
          value={buscar}
          onChange={(e) => {
            setBuscar(e.target.value);
            setPagina(1);
          }}
        />
        {marcas.length > 0 ? (
          <select
            className="cr-input w-auto"
            value={brand}
            onChange={(e) => {
              setMarca(e.target.value);
              setPagina(1);
            }}
            aria-label="Filtrar por marca"
          >
            <option value="">Todas las marcas</option>
            {marcas.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : null}
        {tiendas.length > 0 ? (
          <select
            className="cr-input w-auto"
            value={tienda}
            onChange={(e) => {
              setTienda(e.target.value);
              setPagina(1);
            }}
            aria-label="Filtrar por tienda"
          >
            <option value="">Todas las tiendas</option>
            {tiendas.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {error ? (
        <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
          {error}
        </p>
      ) : null}

      <section className="cr-panel">
        <div className="cr-table-scroll" style={{ "--cr-sticky-2-left": "96px" } as React.CSSProperties}>
          <table className="cr-table">
            <thead>
              <tr>
                {columnas.map((c) => (
                  <th
                    key={c.key}
                    className={[
                      c.tipo === "num" || c.tipo === "pct" ? "num" : "",
                      c.sticky === 1 ? "cr-sticky" : c.sticky === 2 ? "cr-sticky-2" : "",
                      c.ordenable ? "cursor-pointer select-none" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => ordenarPor(c)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.etiqueta}
                      {orden === c.key ? (
                        dir === "asc" ? (
                          <ArrowUp size={10} strokeWidth={2} />
                        ) : (
                          <ArrowDown size={10} strokeWidth={2} />
                        )
                      ) : null}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cargando && filas.length === 0 ? (
                <tr>
                  <td colSpan={columnas.length} className="cr-body py-10 text-center">
                    Cargando…
                  </td>
                </tr>
              ) : filas.length === 0 ? (
                <tr>
                  <td colSpan={columnas.length} className="cr-body py-10 text-center">
                    Sin filas para los filtros seleccionados.
                  </td>
                </tr>
              ) : (
                filas.map((f) => (
                  <tr key={String(f._id)}>
                    {columnas.map((c) => (
                      <td
                        key={c.key}
                        className={[
                          c.tipo === "num" || c.tipo === "pct" ? "num" : "",
                          c.tipo === "date" ? "cr-mono" : "",
                          c.key === "sku" || c.key === "storeCode" || c.key === "purchaseDoc"
                            ? "cr-mono"
                            : "",
                          c.sticky === 1 ? "cr-sticky" : c.sticky === 2 ? "cr-sticky-2" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {celda(f[c.key], c.tipo)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Paginacion pagina={pagina} paginas={paginas} total={total} onCambiar={setPagina} />
      </section>
    </div>
  );
}
