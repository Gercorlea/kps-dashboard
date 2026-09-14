import { AuditLog, Invoice, Supplier } from "@/models/proveedores";

/**
 * Bloquea proveedores que dejaron vencer el plazo de cinco días. Es idempotente
 * y puede ejecutarse desde la alerta programada o una tarea externa.
 */
export async function aplicarBloqueosComplemento() {
  const vencidas = await Invoice()
    .find({
      complementStatus: "PENDIENTE",
      complementDueAt: { $lt: new Date() },
      // El portal hermano guarda aquí el REP validado. Exigir null evita
      // bloquear de nuevo una factura cuyo complemento ya fue recibido.
      paymentReceipt: { $in: [null] },
    }, { folio: 1, supplierCode: 1 })
    .lean();
  const porProveedor = new Map<string, string[]>();
  for (const f of vencidas) {
    porProveedor.set(f.supplierCode, [...(porProveedor.get(f.supplierCode) ?? []), f.folio]);
  }

  for (const [supplierCode, folios] of porProveedor) {
    const motivo = `Complemento de pago vencido: ${folios.join(", ")}`;
    const r = await Supplier().updateOne(
      { supplierCode, $or: [{ blocked: { $ne: true } }, { blockReason: { $ne: motivo } }] },
      { $set: { blocked: true, status: "BLOQUEADO", blockReason: motivo, complementBlockedAt: new Date() } }
    );
    if (r.modifiedCount) {
      await AuditLog().create({
        entityType: "supplier",
        entityId: supplierCode,
        action: "PROVEEDOR_BLOQUEADO_COMPLEMENTO",
        actorId: "sistema",
        actorRole: "SINCRONIZACION",
        before: null,
        after: { blocked: true, folios },
        comment: motivo,
        createdAt: new Date(),
      });
    }
  }

  // El proveedor vuelve a operar cuando el último REP pendiente quedó en cero.
  // Solo se levantan bloqueos creados por este flujo; uno administrativo no se
  // toca aunque ya no haya complementos.
  const bloqueados = await Supplier()
    .find({ blocked: true, blockReason: /^Complemento de pago vencido:/ }, { supplierCode: 1 })
    .lean();
  let proveedoresDesbloqueados = 0;
  for (const proveedor of bloqueados) {
    const pendientes = await Invoice().countDocuments({
      supplierCode: proveedor.supplierCode,
      complementStatus: "PENDIENTE",
      paymentReceipt: { $in: [null] },
    });
    if (pendientes > 0) continue;
    const r = await Supplier().updateOne(
      { supplierCode: proveedor.supplierCode, blocked: true, blockReason: /^Complemento de pago vencido:/ },
      { $set: { blocked: false, status: "ACTIVO", blockReason: null, complementUnblockedAt: new Date() } }
    );
    proveedoresDesbloqueados += r.modifiedCount;
  }
  return { proveedoresBloqueados: porProveedor.size, proveedoresDesbloqueados, facturasVencidas: vencidas.length };
}
