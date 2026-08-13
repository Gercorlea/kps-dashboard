"use client";

import { useEffect, useState } from "react";

/**
 * Valor que se actualiza `ms` después de que dejan de escribir.
 *
 * Lo usan los buscadores de la tabla del analizador: el modo histórico dispara
 * una petición por cambio y el modo archivo recorre 15 mil filas, así que en
 * los dos casos hacerlo por pulsación es desperdicio visible.
 */
export function useDiferido<T>(valor: T, ms = 250): T {
  const [diferido, setDiferido] = useState(valor);

  useEffect(() => {
    const id = setTimeout(() => setDiferido(valor), ms);
    return () => clearTimeout(id);
  }, [valor, ms]);

  return diferido;
}
