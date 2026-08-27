// Campos por defecto por entidad del Service Layer, compartidos por el
// endpoint /api/sap y por la herramienta consultar_sap de KPS AI (así no se
// desincronizan). Sin esto SAP devuelve la entidad completa: un Items trae
// 311 campos y 11 colecciones anidadas, 142 KB por 5 artículos.
//
// Los nombres están verificados contra el Service Layer real. Si añades uno
// que no existe, SAP responde 400 y la entidad ENTERA deja de funcionar.

export const CAMPOS_DOC =
  "DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocCurrency,DocumentStatus";

export const CAMPOS_CLAVE: Record<string, string> = {
  items:
    "ItemCode,ItemName,ItemsGroupCode,BarCode,QuantityOnStock,QuantityOrderedFromVendors,QuantityOrderedByCustomers,InventoryUOM,Valid,U_Marca,U_ArticuloLiverpool,U_ArticuloCoppel,UpdateDate",
  businesspartners:
    "CardCode,CardName,CardType,GroupCode,Phone1,EmailAddress,CurrentAccountBalance,Currency,Valid",
  orders: CAMPOS_DOC,
  invoices: CAMPOS_DOC,
  quotations: CAMPOS_DOC,
  purchaseorders: CAMPOS_DOC,
  purchaseinvoices: CAMPOS_DOC,
  deliverynotes: CAMPOS_DOC,
  purchasedeliverynotes: CAMPOS_DOC,
  creditnotes: CAMPOS_DOC,
  warehouses: "WarehouseCode,WarehouseName,Inactive",
  pricelists: "PriceListNo,PriceListName,BasePriceList,Factor,ValidFrom,ValidTo",
  itemgroups: "Number,GroupName",
  // Lotes: consultar_sap añade a cada fila diasParaVencer, diasDesdeFabricacion,
  // diasDesdeIngreso, vidaUtilRestantePct y estadoFrescura (lib/sap/frescura.ts).
  batchnumberdetails:
    "ItemCode,ItemDescription,Batch,Status,AdmissionDate,ManufacturingDate,ExpirationDate",
};

/**
 * CAMPOS DE USUARIO (U_*) EN Items — específicos de esta instalación.
 *
 * Son la información de negocio que SAP estándar no tiene. Úsalos: sin ellos
 * acabarías adivinando la marca desde el texto de ItemName, que es incorrecto.
 *
 *  U_Marca               brand comercial. Valores reales: MultiBlue, Bloom,
 *                        Al Natural, Spring Valley, Goli, MultiSport, Alux
 *                        Skin, MultiLyte, Botanical Doctor, SWAPPP, Alux, y
 *                        también "Insumos"/"Costco", que NO son marcas de
 *                        venta sino clasificación interna.
 *  U_ArticuloLiverpool   SKU del artículo en Liverpool. Es la MISMA llave que
 *                        el campo `sku` de las colecciones de Retail: por aquí
 *                        se cruza SAP con ventas, pronósticos e inventarios.
 *  U_DescripcionLiverpool  descripción con la que Liverpool lo tiene dado de alta.
 *  U_ArticuloCoppel / U_ArticuloAmazon / U_ArticuloFA  lo mismo para otros retailers.
 *  U_Subgrupo, U_IVAV, U_IVAC, U_cvearticulo, U_cveunidad  fiscales/clasificación.
 *
 * COBERTURA REAL (medida el 2026-08-12 sobre los 160 artículos del catálogo):
 * U_Marca 96%, U_ArticuloLiverpool 6%, U_ArticuloCoppel 4%, U_ArticuloAmazon
 * 2%, U_ArticuloFA 2%. Es decir: la marca es fiable; el mapeo a SKUs de
 * retailer está casi sin capturar, así que un cruce por SKU hoy falla en la
 * mayoría de los artículos. Si te preguntan por ese cruce, dilo en vez de
 * presentar un resultado parcial como si fuera completo.
 */

/**
 * CÓMO LEER PRECIOS. Verificado en vivo; no improvises otra vía.
 *
 * 1) NO existe un entity set "ItemPrices". Pedirlo da error. Los precios de
 *    lista son una colección ANIDADA dentro de Items.
 *
 * 2) Precio de LISTA: pide la colección en los campos, sin $expand.
 *       { entidad: "Items", campos: ["ItemCode","U_Marca","ItemPrices"], top: 100 }
 *    y pagina con `saltar` (100, 200…) hasta cubrir el `total`. Cada artículo
 *    trae 10 renglones, uno por lista; Price 0 = sin precio cargado.
 *    ESTADO REAL (2026-08-12): solo 2 de 160 artículos tienen algún precio.
 *    Las listas están prácticamente vacías, así que el precio de lista NO
 *    sirve para valorizar nada.
 *
 * 3) Precio REAL de venta: está en las facturas, no en las listas.
 *       { entidad: "Invoices", campos: ["DocNum","DocDate","CardName","DocumentLines"] }
 *    Cada línea trae ItemCode, Quantity, Price (unitario) y LineTotal. Para
 *    importes por marca, cruza ese ItemCode contra U_Marca de Items.
 *    Hay 8931 facturas entre 2025-12-31 y 2026-07-24. Ejemplo: la 7248
 *    (COSTCO DE MEXICO) vendió PTMB0017 a 370 MXP, artículo que NO tiene
 *    precio en ninguna lista.
 *    Ojo: hay documentos de "Saldo inicial" sin ItemCode; no son ventas.
 *
 * Los importes de SAP están en MXP. El módulo Retail NO tiene dinero: sus
 * cifras (unidades, valor) son unidades, así que cualquier pregunta de pesos
 * se responde con SAP.
 */

/**
 * LOTES Y FRESCURA. Los lotes viven en el entity set BatchNumberDetails (uno
 * por artículo × lote, con AdmissionDate, ManufacturingDate y
 * ExpirationDate). Para "cuántos días de frescura tiene el lote X":
 *   { entidad: "BatchNumberDetails", filtro: "Batch eq 'X'" }
 * (añade " and ItemCode eq '…'" si hay varios artículos con el mismo lote).
 * consultar_sap devuelve cada fila YA con diasParaVencer, diasDesdeFabricacion,
 * diasDesdeIngreso, vidaUtilDias, vidaUtilRestantePct y estadoFrescura
 * (vigente / por vencer ≤90 días / caducado): úsalos tal cual, nunca restes
 * fechas. BatchNumberDetails NO trae existencias por lote; las unidades
 * VENDIDAS por lote están en la colección sapSalesLotes de consultar_retail.
 */

/** "Items('INS0002')" → "items" */
export function nombreEntidad(segmento: string): string {
  return segmento.split("(")[0].toLowerCase();
}

/** Campos por defecto de una entidad, o undefined si no tiene lista propia. */
export function camposPorDefecto(segmento: string): string | undefined {
  return CAMPOS_CLAVE[nombreEntidad(segmento)];
}
