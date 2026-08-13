// Tipos del analizador ad-hoc de Excel (§7 bis): el usuario sube un .xlsx
// cualquiera y la app infiere su esquema en vez de exigir las hojas fijas del
// flujo de ingesta. Todo el módulo es puro salvo parsear.ts, que es la
// frontera de I/O.

export type CeldaCruda = string | number | boolean | Date | null;
export type FilaCruda = CeldaCruda[];

export type TipoColumna = "fecha" | "numero" | "categoria" | "vacia";

// Cómo interpretar un separador solitario en un número escrito como texto.
// Se decide por columna, nunca por celda (ver inferir-tipos.ts).
export type FormatoNumerico = "coma-miles" | "punto-miles" | "nativo";

export type Agregacion = "suma" | "promedio" | "conteo";
export type Granularidad = "dia" | "mes" | "anio";

export interface MetaColumna {
  indice: number;
  nombre: string;
  tipo: TipoColumna;
  noVacias: number;
  cardinalidad: number; // distintos observados en la muestra
  esIdentificador: boolean; // cardinalidad/noVacias > 0.9 y todos enteros: folios, IDs
  magnitud: number; // suma de |v| sobre la muestra; 0 si no es numérica
  formatoNumerico: FormatoNumerico;
  // Para columnas de fecha escritas como texto: orden de los componentes.
  ordenFecha: "dia-mes" | "mes-dia" | null;
}

export interface Dataset {
  hoja: string;
  filaEncabezado: number; // índice 0-based dentro de la hoja cruda; -1 si no hay
  columnas: MetaColumna[];
  filas: FilaCruda[];
  totalFilas: number;
}

export interface HojaCruda {
  nombre: string;
  datos: FilaCruda[];
}

// Métrica sintética "Cantidad de filas". Siempre disponible, incluso si el
// archivo no trae ninguna columna numérica.
export const METRICA_CONTEO = -1;

export interface PuntoAgrupado {
  clave: string;
  valor: number;
  suma: number;
  conteo: number;
  // Sólo en el bucket "Otros": cuántos grupos se plegaron dentro.
  gruposPlegados?: number;
}

export interface PuntoSerie {
  clave: string;
  valor: number;
}

export interface Kpis {
  totalMetrica: number;
  totalFilas: number;
  dimensionesDistintas: number;
  rangoFechas: { desde: Date; hasta: Date } | null;
}
