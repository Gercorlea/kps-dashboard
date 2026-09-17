"use client";

// Pestaña "Faltantes" de la ficha de un retailer: los productos del catálogo de
// KPS que esa cadena todavía no tiene dados de alta, y el alta desde la propia
// fila.
//
// Recibe la lista entera —~130 productos como mucho— y busca y pagina en el
// navegador. Por eso el buscador responde en cada tecla, sin viaje al servidor,
// igual que la tabla del módulo de catálogo.

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { PackageSearch } from "lucide-react";
import { BuscadorTabla } from "@/components/catalogo/BuscadorTabla";
import { Paginacion } from "@/components/dashboard/Paginacion";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtNum } from "@/components/lib/fmt";
import { useFilasQueCaben } from "@/components/lib/useFilasQueCaben";
import { RetailerTablaSkeleton } from "@/components/retail/RetailerSkeleton";
import { Badge, EstadoVacio, Panel } from "@/components/ui/basicos";
import { useToast } from "@/components/ui/Toast";
import { tonoEstatus } from "@/lib/catalogo/estatus";
import type { FilaFaltante } from "@/lib/catalogo/tipos";
import { paginar, totalPaginas } from "@/lib/retail/analisis/filtrar";

/** Alto de fila del design system; lo usa la medición de la paginación. */
const ALTO_FILA = 44;

const COLUMNAS_BUSCADAS = ["Item", "Descripción", "Estatus"];

export function RetailerFaltantes({
  retailer,
  nombre,
  filas,
  cargando,
  error,
  hayCatalogo,
  puedeCatalogo,
  onReintentar,
  onAlta,
}: {
  /** Id del retailer; es la cuenta a la que se da de alta el producto. */
  retailer: string;
  nombre: string;
  /** Los faltantes, o null mientras viajan. */
  filas: FilaFaltante[] | null;
  cargando: boolean;
  error: boolean;
  /** false = nunca se ha cargado un catálogo; no es un error. */
  hayCatalogo: boolean;
  /** Si esta persona puede entrar a /catalogo, para no ofrecerle un 403. */
  puedeCatalogo: boolean;
  onReintentar: () => void;
  /** Saca de la lista el producto recién dado de alta. */
  onAlta: (item: string) => void;
}) {
  const toast = useToast();
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  // Un mapa por campo para todas las filas, en vez de un componente por fila:
  // el mismo trato que el alta de proveedores.
  const [codigos, setCodigos] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState<string | null>(null);

  const todas = useMemo(() => filas ?? [], [filas]);

  const termino = busqueda.trim().toLowerCase();
  const filtradas = useMemo(
    () =>
      todas.filter(
        (f) =>
          !termino ||
          `${f.item} ${f.description} ${f.status}`.toLowerCase().includes(termino)
      ),
    [todas, termino]
  );

  const { ancla, filas: filasQueCaben } = useFilasQueCaben({
    altoFila: ALTO_FILA,
    minimo: 1,
    recalcularCon: [todas, cargando, error, hayCatalogo],
  });
  const porPagina = filasQueCaben ?? 10;
  const paginas = totalPaginas(filtradas.length, porPagina);
  const paginaActual = Math.min(Math.max(1, pagina), paginas);
  const visibles = useMemo(
    () => paginar(filtradas, paginaActual, porPagina),
    [filtradas, paginaActual, porPagina]
  );

  /** Buscar devuelve a la página 1: si no, se vería una tabla vacía. */
  const buscar = useCallback((v: string) => {
    setBusqueda(v);
    setPagina(1);
  }, []);

  const darDeAlta = useCallback(
    async (f: FilaFaltante) => {
      const customerCode = (codigos[f.item] ?? "").trim();
      // Se comprueba aquí y también en el servidor: el viaje para que conteste
      // "falta el código" no aporta nada y el aviso llega más tarde.
      if (!customerCode) {
        toast.error(
          "Falta el código del cliente",
          `Escribe el código con el que ${nombre} da de alta ${f.item}.`
        );
        return;
      }
      setGuardando(f.item);
      try {
        const r = await api<{ creado: boolean }>("/api/retail/faltantes", {
          method: "POST",
          body: JSON.stringify({ account: retailer, item: f.item, customerCode }),
        });
        toast.ok(
          r.creado ? `${f.item} dado de alta en ${nombre}` : `${f.item} actualizado`,
          `${f.description} · código ${customerCode}`
        );
        setCodigos((c) => ({ ...c, [f.item]: "" }));
        // Ya no falta: sale de la lista sin volver a pedirla entera.
        onAlta(f.item);
      } catch (e) {
        toast.error(
          "No se pudo dar de alta el producto",
          e instanceof ClientApiError ? e.message : undefined
        );
      } finally {
        setGuardando(null);
      }
    },
    [codigos, nombre, onAlta, retailer, toast]
  );

  if (cargando) {
    return (
      <div className="cr-pulse" aria-busy="true">
        <RetailerTablaSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <Panel>
        <div className="flex flex-col items-center gap-3 py-8">
          <p className="cr-body text-center">
            No se pudo cruzar el catálogo con los datos de {nombre}.
          </p>
          <button
            type="button"
            className="cr-btn cr-btn--secondary cr-btn--sm"
            onClick={onReintentar}
          >
            Reintentar
          </button>
        </div>
      </Panel>
    );
  }

  if (!hayCatalogo) {
    return (
      <Panel>
        <EstadoVacio
          title="Todavía no hay un catálogo cargado"
          detalle={`Sin el catálogo de KPS no hay contra qué comparar lo que vende ${nombre}. En cuanto se suba, aquí aparecerán los productos que le faltan.`}
        >
          <PackageSearch strokeWidth={1.25} size={28} style={{ color: "var(--cr-ink-3)" }} />
        </EstadoVacio>
        {/* El enlace sólo para quien puede entrar: ofrecer un 403 es peor que
            no ofrecer nada. */}
        {puedeCatalogo ? (
          <p className="cr-body pb-6 text-center">
            <Link href="/catalogo" className="cr-link">
              Ir al catálogo
            </Link>
          </p>
        ) : null}
      </Panel>
    );
  }

  if (todas.length === 0) {
    return (
      <Panel>
        <EstadoVacio
          title={`${nombre} ya tiene dado de alta todo el catálogo`}
          detalle="Todos los productos activos y en lanzamiento tienen un código asignado para esta cadena."
        >
          <PackageSearch strokeWidth={1.25} size={28} style={{ color: "var(--cr-ink-3)" }} />
        </EstadoVacio>
      </Panel>
    );
  }

  return (
    <section className="cr-panel">
      <header className="cr-panel__head flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="cr-h3">Productos sin dar de alta en {nombre}</h3>
          <span className="cr-small cr-ink-3">
            {termino
              ? `${fmtNum(filtradas.length)} de ${fmtNum(todas.length)} productos`
              : `${fmtNum(todas.length)} productos`}
          </span>
        </div>
        <BuscadorTabla
          busqueda={busqueda}
          onBusqueda={buscar}
          placeholder="Buscar producto…"
          columnasBuscadas={COLUMNAS_BUSCADAS}
        />
      </header>

      <div ref={ancla}>
        <table className="cr-table cr-table--fija cr-catalogo__tabla">
          <colgroup>
            <col className="cr-catalogo__item" />
            <col />
            <col className="cr-catalogo__estatus" />
            <col className="cr-catalogo__upc" />
            <col className="cr-catalogo__unidad" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Descripción</th>
              <th scope="col">Estatus</th>
              <th scope="col">Código del cliente</th>
              <th scope="col">
                <span className="sr-only">Dar de alta</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 ? (
              <tr>
                <td colSpan={5} className="cr-catalogo__sin-resultados">
                  {`Ningún producto coincide con «${busqueda.trim()}».`}
                </td>
              </tr>
            ) : (
              visibles.map((f) => {
                const enCurso = guardando === f.item;
                return (
                  <tr key={f.item}>
                    <td className="cr-mono">
                      <span className="block truncate" title={f.item}>
                        {f.item}
                      </span>
                    </td>
                    <td>
                      <span className="block truncate" title={f.description}>
                        {f.description || "—"}
                      </span>
                    </td>
                    <td>
                      {f.status ? (
                        <span title={f.status}>
                          <Badge tono={tonoEstatus(f.status)}>{f.status}</Badge>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <input
                        className="cr-input cr-input--sm"
                        // `text` y no `number`: el código puede traer un cero a
                        // la izquierda o no ser numérico ("A-1004"), y un input
                        // numérico se comería las dos cosas.
                        type="text"
                        value={codigos[f.item] ?? ""}
                        placeholder="Código en la cadena"
                        onChange={(e) =>
                          setCodigos((c) => ({ ...c, [f.item]: e.target.value }))
                        }
                        // Enter dentro del campo da de alta: es el gesto natural
                        // cuando se acaba de escribir el código.
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !enCurso) void darDeAlta(f);
                        }}
                        aria-label={`Código de ${f.item} en ${nombre}`}
                        disabled={enCurso}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="cr-btn cr-btn--primary cr-btn--sm"
                        onClick={() => void darDeAlta(f)}
                        disabled={enCurso}
                      >
                        {enCurso ? "Guardando…" : "Dar de alta"}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Paginacion
        siempreVisible
        pagina={paginaActual}
        paginas={paginas}
        total={filtradas.length}
        porPagina={porPagina}
        onCambiar={setPagina}
        sustantivo="productos"
      />
    </section>
  );
}
