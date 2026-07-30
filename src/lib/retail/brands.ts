// Derivación de marca (§7.3). No existe columna de marca en el archivo:
// se deriva del prefijo de la descripción. Un split por el primer espacio
// no funciona ("AL NATURAL" son dos palabras) y un startsWith("MULTI")
// fusionaría tres marcas distintas. Catálogo en un solo archivo: agregar
// una marca nueva es una línea.

export const MARCA_SIN_CLASIFICAR = "SIN CLASIFICAR";

// 1. Normalizar: mayúsculas, quitar acentos, colapsar espacios múltiples
//    ("GOLI  WOMEN´S" trae doble espacio)
export const norm = (s: string) =>
  s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// 2. Catálogo ORDENADO: patrones más largos/específicos primero
export const MARCAS: Array<{ marca: string; patrones: string[] }> = [
  { marca: "AL NATURAL",       patrones: ["AL NATURAL"] },
  { marca: "BOTANICAL DOCTOR", patrones: ["BOTANICAL DOCTOR", "BOTANICAL"] },
  { marca: "MULTIBLUE",        patrones: ["MULTIBLUE"] },
  { marca: "MULTILYTE",        patrones: ["MULTILYTE"] },
  { marca: "MULTISPORT",       patrones: ["MULTISPORT"] },
  { marca: "BLOOM",            patrones: ["BLOOM"] },
  { marca: "GOLI",             patrones: ["GOLI"] },     // GOLÍ cae aquí tras normalizar
  { marca: "VALNAIT",          patrones: ["VALNAIT"] },  // cubre "VALNAIT-DES"
];

// 3. Match por prefijo contra la descripción normalizada, en orden.
// 4. Sin match → "SIN CLASIFICAR"; el llamador registra la incidencia para
//    que las marcas nuevas sean visibles en la UI, no un cajón escondido.
export function derivarMarca(descripcion: string): {
  marca: string;
  clasificada: boolean;
} {
  const d = norm(descripcion ?? "");
  if (!d) return { marca: MARCA_SIN_CLASIFICAR, clasificada: false };
  for (const { marca, patrones } of MARCAS) {
    for (const patron of patrones) {
      if (d.startsWith(patron)) return { marca, clasificada: true };
    }
  }
  return { marca: MARCA_SIN_CLASIFICAR, clasificada: false };
}
