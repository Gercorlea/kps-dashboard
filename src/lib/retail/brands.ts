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
export const MARCAS: Array<{ brand: string; patrones: string[] }> = [
  { brand: "AL NATURAL",       patrones: ["AL NATURAL"] },
  { brand: "BOTANICAL DOCTOR", patrones: ["BOTANICAL DOCTOR", "BOTANICAL"] },
  { brand: "MULTIBLUE",        patrones: ["MULTIBLUE"] },
  { brand: "MULTILYTE",        patrones: ["MULTILYTE"] },
  { brand: "MULTISPORT",       patrones: ["MULTISPORT"] },
  { brand: "BLOOM",            patrones: ["BLOOM"] },
  { brand: "GOLI",             patrones: ["GOLI"] },     // GOLÍ cae aquí tras normalizar
  { brand: "VALNAIT",          patrones: ["VALNAIT"] },  // cubre "VALNAIT-DES"
];

// 3. Match por prefijo contra la descripción normalizada, en orden.
// 4. Sin match → "SIN CLASIFICAR"; el llamador registra la incidencia para
//    que las marcas nuevas sean visibles en la UI, no un cajón escondido.
export function derivarMarca(description: string): {
  brand: string;
  clasificada: boolean;
} {
  const d = norm(description ?? "");
  if (!d) return { brand: MARCA_SIN_CLASIFICAR, clasificada: false };
  for (const { brand, patrones } of MARCAS) {
    for (const patron of patrones) {
      if (d.startsWith(patron)) return { brand, clasificada: true };
    }
  }
  return { brand: MARCA_SIN_CLASIFICAR, clasificada: false };
}
