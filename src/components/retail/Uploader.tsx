"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { CheckCircle2, FileSpreadsheet, Loader2, UploadCloud, XCircle } from "lucide-react";
import { api, ClientApiError } from "@/components/lib/api-client";
import { fmtBytes, fmtNum } from "@/components/lib/fmt";
import { Badge, Meter, Panel } from "@/components/ui/basicos";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_BYTES = 25 * 1024 * 1024;

type Paso =
  | { tipo: "seleccion" }
  | { tipo: "subiendo"; progreso: number }
  | { tipo: "confirmar" }
  | { tipo: "procesando" }
  | { tipo: "listo" }
  | { tipo: "duplicado"; uploadIdExistente: string };

interface ResumenHoja {
  leidas: number;
  insertadas: number;
  rechazadas: number;
}

interface Incidencia {
  hoja: string;
  fila?: number;
  campo?: string;
  mensaje: string;
}

export function Uploader() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [paso, setPaso] = useState<Paso>({ tipo: "seleccion" });
  const [error, setError] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [fechaCorte, setFechaCorte] = useState("");
  const [fechaDerivada, setFechaDerivada] = useState(false);
  const [hojas, setHojas] = useState<string[]>([]);
  const [resumen, setResumen] = useState<Record<string, ResumenHoja>>({});
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [statusFinal, setStatusFinal] = useState<string>("");
  const [arrastrando, setArrastrando] = useState(false);

  function reiniciar() {
    setArchivo(null);
    setPaso({ tipo: "seleccion" });
    setError(null);
    setUploadId(null);
    setFechaCorte("");
    setHojas([]);
    setResumen({});
    setIncidencias([]);
    setStatusFinal("");
  }

  async function leerNombresDeHojas(f: File) {
    // Solo los NOMBRES de hoja para el paso de confirmación; el parseo de
    // las ~37 mil filas corre siempre en el servidor (§7).
    try {
      const XLSX = await import("xlsx");
      const buffer = await f.arrayBuffer();
      const wb = XLSX.read(buffer, { bookSheets: true });
      setHojas(wb.SheetNames ?? []);
    } catch {
      setHojas([]);
    }
  }

  async function seleccionar(f: File) {
    setError(null);
    // Validación en cliente: extensión y tamaño (§10). El servidor
    // re-valida con Zod antes de emitir la URL firmada (§5.7).
    if (!f.name.toLowerCase().endsWith(".xlsx")) {
      setError("Solo se aceptan archivos .xlsx");
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`El archivo pesa ${fmtBytes(f.size)}; el máximo es 25 MB`);
      return;
    }
    setArchivo(f);
    void leerNombresDeHojas(f);

    try {
      const creado = await api<{
        uploadId: string;
        putUrl: string;
        fechaCorteSugerida: string;
        fechaDerivadaDelNombre: boolean;
      }>("/api/retail/uploads", {
        method: "POST",
        body: JSON.stringify({
          filename: f.name,
          contentType: XLSX_MIME,
          sizeBytes: f.size,
          cuenta: "san-pablo",
        }),
      });
      setUploadId(creado.uploadId);
      setFechaCorte(creado.fechaCorteSugerida);
      setFechaDerivada(creado.fechaDerivadaDelNombre);

      // Subida directa a R2 con presigned PUT y barra de progreso.
      setPaso({ tipo: "subiendo", progreso: 0 });
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", creado.putUrl);
        xhr.setRequestHeader("Content-Type", XLSX_MIME);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            setPaso({ tipo: "subiendo", progreso: ev.loaded / ev.total });
          }
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`R2 respondió ${xhr.status}`));
        xhr.onerror = () => reject(new Error("Fallo de red subiendo a R2 (¿CORS del bucket?)"));
        xhr.send(f);
      });
      setPaso({ tipo: "confirmar" });
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : String(e instanceof Error ? e.message : e));
      setPaso({ tipo: "seleccion" });
    }
  }

  async function procesar() {
    if (!uploadId || !fechaCorte) return;
    setError(null);
    setPaso({ tipo: "procesando" });

    // Polling del avance por hoja mientras el POST procesa (§7 paso 4).
    const intervalo = window.setInterval(async () => {
      try {
        const r = await api<{ carga: { resumen: Record<string, ResumenHoja> } }>(
          `/api/retail/uploads/${uploadId}`
        );
        setResumen(r.carga.resumen ?? {});
      } catch {
        /* el polling no interrumpe el procesamiento */
      }
    }, 1500);

    try {
      const r = await api<{
        status: string;
        resumen: Record<string, ResumenHoja>;
        incidencias: Incidencia[];
      }>(`/api/retail/uploads/${uploadId}/process`, {
        method: "POST",
        body: JSON.stringify({ fechaCorte }),
      });
      setResumen(r.resumen ?? {});
      setIncidencias(r.incidencias ?? []);
      setStatusFinal(r.status);
      setPaso({ tipo: "listo" });
    } catch (e) {
      if (e instanceof ClientApiError && e.code === "DUPLICADO") {
        const detalles = e.details as { uploadId?: string } | undefined;
        setPaso({ tipo: "duplicado", uploadIdExistente: detalles?.uploadId ?? "" });
      } else {
        setError(e instanceof ClientApiError ? e.message : "Error al procesar");
        setPaso({ tipo: "confirmar" });
      }
    } finally {
      window.clearInterval(intervalo);
    }
  }

  const marcasSinClasificar = incidencias.filter((i) => i.campo === "marca");

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {paso.tipo === "seleccion" ? (
        <Panel>
          <button
            type="button"
            className="flex w-full flex-col items-center gap-3 border border-dashed px-6 py-16 text-center transition-colors"
            style={{
              borderColor: arrastrando ? "var(--cr-ink)" : "var(--cr-line-2)",
              borderRadius: "var(--cr-r-sm)",
              background: arrastrando ? "var(--cr-surface-2)" : "transparent",
            }}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setArrastrando(true);
            }}
            onDragLeave={() => setArrastrando(false)}
            onDrop={(e) => {
              e.preventDefault();
              setArrastrando(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void seleccionar(f);
            }}
          >
            <UploadCloud size={28} strokeWidth={1.5} style={{ color: "var(--cr-ink-2)" }} />
            <span className="cr-h3">Arrastra el Excel semanal o haz clic para elegirlo</span>
            <span className="cr-small">Solo .xlsx · máximo 25 MB · cuenta San Pablo</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void seleccionar(f);
              e.target.value = "";
            }}
          />
        </Panel>
      ) : null}

      {paso.tipo === "subiendo" && archivo ? (
        <Panel titulo="Subiendo a almacenamiento seguro">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <FileSpreadsheet size={16} strokeWidth={1.75} />
              <span className="cr-body">{archivo.name}</span>
              <span className="cr-small cr-mono ml-auto">{fmtBytes(archivo.size)}</span>
            </div>
            <Meter valor={paso.progreso} tono="ink" />
            <span className="cr-small cr-mono">{Math.round(paso.progreso * 100)}%</span>
          </div>
        </Panel>
      ) : null}

      {paso.tipo === "confirmar" && archivo ? (
        <Panel titulo="Confirmar antes de procesar">
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="cr-field">
                <span className="cr-label">Fecha de corte (requerida)</span>
                <input
                  type="date"
                  className="cr-input"
                  value={fechaCorte}
                  onChange={(e) => setFechaCorte(e.target.value)}
                  required
                />
                <span className="cr-small">
                  {fechaDerivada
                    ? "Derivada del nombre del archivo — corrígela si no corresponde."
                    : "No se pudo derivar del nombre del archivo: confírmala manualmente."}
                </span>
              </label>
              <div className="cr-field">
                <span className="cr-label">Cuenta</span>
                <span className="cr-input flex items-center">San Pablo</span>
              </div>
            </div>
            <div className="cr-field">
              <span className="cr-label">Hojas detectadas</span>
              <div className="flex flex-wrap gap-1.5">
                {hojas.length > 0 ? (
                  hojas.map((h) => <Badge key={h}>{h}</Badge>)
                ) : (
                  <span className="cr-small">Se detectarán al procesar.</span>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className="cr-btn cr-btn--primary"
                onClick={procesar}
                disabled={!fechaCorte}
              >
                Procesar
              </button>
              <button type="button" className="cr-btn cr-btn--ghost" onClick={reiniciar}>
                Cancelar
              </button>
            </div>
          </div>
        </Panel>
      ) : null}

      {paso.tipo === "procesando" || paso.tipo === "listo" ? (
        <Panel
          titulo={
            paso.tipo === "procesando" ? (
              <span className="flex items-center gap-2">
                <Loader2 className="cr-spin" size={15} strokeWidth={1.75} />
                Procesando hoja por hoja…
              </span>
            ) : statusFinal === "procesado" ? (
              <span className="flex items-center gap-2">
                <CheckCircle2 size={15} strokeWidth={1.75} style={{ color: "var(--cr-ok)" }} />
                Carga procesada
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <XCircle size={15} strokeWidth={1.75} style={{ color: "var(--cr-danger)" }} />
                Carga con errores
              </span>
            )
          }
          sinPadding
        >
          <div className="cr-table-scroll">
            <table className="cr-table">
              <thead>
                <tr>
                  <th>Hoja</th>
                  <th className="num">Leídas</th>
                  <th className="num">Insertadas</th>
                  <th className="num">Rechazadas</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(resumen).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="cr-body py-6 text-center">
                      Descargando y parseando el archivo…
                    </td>
                  </tr>
                ) : (
                  Object.entries(resumen).map(([hoja, r]) => (
                    <tr key={hoja}>
                      <td>{hoja}</td>
                      <td className="num">{fmtNum(r.leidas)}</td>
                      <td className="num">{fmtNum(r.insertadas)}</td>
                      <td className="num">
                        {r.rechazadas > 0 ? (
                          <span style={{ color: "var(--cr-danger)" }}>{fmtNum(r.rechazadas)}</span>
                        ) : (
                          "0"
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {paso.tipo === "listo" ? (
            <div className="flex flex-col gap-3 border-t p-4" style={{ borderColor: "var(--cr-line-soft)" }}>
              {marcasSinClasificar.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <Badge tono="warn">
                    {marcasSinClasificar.length} marcas sin clasificar
                  </Badge>
                  <ul className="cr-small list-inside list-disc">
                    {marcasSinClasificar.slice(0, 8).map((i, idx) => (
                      <li key={idx}>{i.mensaje}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {incidencias.filter((i) => i.campo !== "marca").length > 0 ? (
                <details>
                  <summary className="cr-small cursor-pointer">
                    {incidencias.filter((i) => i.campo !== "marca").length} incidencias registradas
                  </summary>
                  <ul className="cr-small mt-2 list-inside list-disc">
                    {incidencias
                      .filter((i) => i.campo !== "marca")
                      .slice(0, 20)
                      .map((i, idx) => (
                        <li key={idx}>
                          [{i.hoja}
                          {i.fila ? ` · fila ${i.fila}` : ""}] {i.mensaje}
                        </li>
                      ))}
                  </ul>
                </details>
              ) : null}
              <div className="flex gap-2">
                {uploadId ? (
                  <Link href={`/retail/${uploadId}`} className="cr-btn cr-btn--primary">
                    Ver detalle de la carga
                  </Link>
                ) : null}
                <button type="button" className="cr-btn cr-btn--secondary" onClick={reiniciar}>
                  Subir otro archivo
                </button>
              </div>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {paso.tipo === "duplicado" ? (
        <Panel titulo="Archivo duplicado">
          <div className="flex flex-col gap-3">
            <p className="cr-body">
              Este archivo ya fue cargado antes (mismo contenido). No se duplicaron filas.
            </p>
            <div className="flex gap-2">
              {paso.uploadIdExistente ? (
                <Link
                  href={`/retail/${paso.uploadIdExistente}`}
                  className="cr-btn cr-btn--primary"
                >
                  Ver la carga existente
                </Link>
              ) : null}
              <button type="button" className="cr-btn cr-btn--secondary" onClick={reiniciar}>
                Subir otro archivo
              </button>
            </div>
          </div>
        </Panel>
      ) : null}

      {error ? (
        <p className="cr-small" style={{ color: "var(--cr-danger)" }} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
