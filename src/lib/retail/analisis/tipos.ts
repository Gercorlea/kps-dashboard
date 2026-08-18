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

/**
 * Cómo se junta una métrica cuando varias filas caen en el mismo grupo.
 *
 * Lo aditivo se suma y ya. El problema son las columnas que YA vienen
 * promediadas por fila —"Avg Price", "Avg Sales $ per Store"—: sumarlas da un
 * número sin significado (el precio promedio de un producto salía en 167,618 en
 * vez de 239). Para ésas hay dos lecturas honestas:
 *
 * · "razon" reconstruye el promedio verdadero dividiendo dos columnas que sí
 *   son aditivas. Es EXACTO cuando la identidad existe en el reporte —en el de
 *   Walmart, Avg Price es exactamente POS Sales / POS Qty— y además ignora
 *   solo las filas sin venta, que aportan 0 arriba y 0 abajo.
 * · "promedio" es la media de las filas que traían el dato, para cuando no hay
 *   con qué reconstruirla.
 */
export type AgregadoMetrica =
  | { tipo: "suma" }
  | { tipo: "promedio" }
  | { tipo: "razon"; numerador: string; divisor: string };
export type Granularidad = "dia" | "mes" | "anio";

export interface MetaColumna {
  indice: number;
  nombre: string;
  tipo: TipoColumna;
  noVacias: number;
  cardinalidad: number; // distintos observados en la muestra
  esIdentificador: boolean; // folios, UPC, SKU: no son magnitudes que sumar
  // Un solo valor distinto en toda la columna ("Vendor Name", "Vendor Nbr"):
  // no sirve ni para agrupar ni para medir, así que se excluye de los filtros.
  esConstante: boolean;
  magnitud: number; // suma de |v| sobre la muestra; 0 si no es numérica
  formatoNumerico: FormatoNumerico;
  /**
   * La columna es un importe y se muestra con "$". Opcional porque la
   * inferencia no lo adivina: un número no dice si son pesos o piezas, así que
   * sólo lo declara la plantilla (ver `moneda` en plantillas.ts).
   */
  esMoneda?: boolean;
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
