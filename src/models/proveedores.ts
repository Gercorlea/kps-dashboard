import { Schema, type Model, type Types } from "mongoose";
import { connectProveedoresDB } from "@/lib/db-proveedores";

// Modelos de la base del Portal de Proveedores.
//
// Van todos en un archivo, y no uno por archivo como el resto de src/models,
// porque comparten algo que no se puede equivocar: viven en la conexión
// SECUNDARIA. Registrar cualquiera de estos en la conexión por defecto los
// crearía en `cronos-retail`, y `suppliers` o `invoices` ahí no significan nada.
//
// DOS DECISIONES QUE NO SON DE ESTILO
//
//   1. `strict: false`. El dueño del esquema es el portal, no este proyecto.
//      Con strict, mongoose descarta en silencio cualquier campo que aquí no
//      esté declarado: bastaría con que el portal añadiera uno para que este
//      dashboard lo borrara al guardar.
//
//   2. `collection` explícito. La pluralización de mongoose daría `auditlogs` e
//      `invoiceevents`; el portal usa `auditLog` e `invoiceEvents`. Sin fijarlo
//      se escribiría en colecciones paralelas vacías y nadie vería el error.

const conn = () => connectProveedoresDB();

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

export type SupplierType = "MERCANCIA" | "SERVICIO";
export type SupplierStatus =
  | "ALTA_PENDIENTE"
  | "ALTA_CORRECCION"
  | "ALTA_RECHAZADA"
  | "ACTIVO"
  | "BLOQUEADO"
  | "INACTIVO";

export interface ISupplier {
  _id: Types.ObjectId;
  supplierCode: string | null;
  type: SupplierType;
  status: SupplierStatus;
  taxId: string;
  legalName: string;
  fiscalAddress: Record<string, unknown>;
  contact: Record<string, unknown>;
  paymentTerms: string;
  currency: string | null;
  groupCode: number | null;
  sapValid: boolean | null;
  blocked: boolean;
  blockReason: string | null;
  services: unknown[];
  onboarding: Record<string, unknown> | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SupplierSchema = new Schema<ISupplier>(
  {
    supplierCode: { type: String, default: null },
    type: { type: String, enum: ["MERCANCIA", "SERVICIO"], required: true },
    status: { type: String, required: true },
    taxId: { type: String, required: true },
    legalName: { type: String, required: true },
    fiscalAddress: { type: Schema.Types.Mixed, default: {} },
    contact: { type: Schema.Types.Mixed, default: {} },
    paymentTerms: { type: String, default: "" },
    currency: { type: String, default: null },
    groupCode: { type: Number, default: null },
    sapValid: { type: Boolean, default: null },
    blocked: { type: Boolean, default: false },
    blockReason: { type: String, default: null },
    services: { type: [Schema.Types.Mixed], default: [] },
    onboarding: { type: Schema.Types.Mixed, default: null },
    syncedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: false, collection: "suppliers" }
);

// ---------------------------------------------------------------------------
// Facturas — las "peticiones" que revisa KPS
// ---------------------------------------------------------------------------

export interface IInvoice {
  _id: Types.ObjectId;
  folio: string;
  type: "MERCANCIA" | "SERVICIO";
  supplierCode: string;
  status: string;
  uuid: string | null;
  serie: string | null;
  issueDate: Date | null;
  issuerTaxId: string | null;
  receiverTaxId: string | null;
  subtotal: Types.Decimal128 | null;
  taxTransferred: Types.Decimal128 | null;
  taxWithheld: Types.Decimal128 | null;
  total: Types.Decimal128 | null;
  currency: string | null;
  paymentMethod: string | null;
  paymentForm: string | null;
  lines: unknown[];
  poNumber: string | null;
  goodsReceiptNumber: string | null;
  xmlFileKey: string | null;
  pdfFileKey: string | null;
  /** Mixed[]: la forma la fija el portal, aqui solo se transporta. */
  evidence: unknown[];
  submittedAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  /**
   * Archivado: se saca de la bandeja sin borrar nada.
   *
   * No es un estatus. El estatus lo fija el portal y dice donde esta la factura
   * en su ciclo; esto dice si KPS quiere seguir viendola en la lista, que es
   * cosa de esta pantalla y de nadie mas. Meterlo en `status` romperia la
   * maquina de estados del portal y perderia el estado real al restaurar.
   */
  archivedAt: Date | null;
  archivedBy: string | null;
  archiveReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceSchema = new Schema<IInvoice>(
  {
    folio: { type: String, required: true },
    type: { type: String, required: true },
    supplierCode: { type: String, required: true },
    status: { type: String, required: true },
    uuid: { type: String, default: null },
    serie: { type: String, default: null },
    issueDate: { type: Date, default: null },
    issuerTaxId: { type: String, default: null },
    receiverTaxId: { type: String, default: null },
    // Decimal128 y no Number: un importe fiscal en coma flotante pierde
    // centavos al sumarlo, y el portal ya los guarda como Decimal128.
    subtotal: { type: Schema.Types.Decimal128, default: null },
    taxTransferred: { type: Schema.Types.Decimal128, default: null },
    taxWithheld: { type: Schema.Types.Decimal128, default: null },
    total: { type: Schema.Types.Decimal128, default: null },
    currency: { type: String, default: null },
    paymentMethod: { type: String, default: null },
    paymentForm: { type: String, default: null },
    lines: { type: [Schema.Types.Mixed], default: [] },
    poNumber: { type: String, default: null },
    goodsReceiptNumber: { type: String, default: null },
    xmlFileKey: { type: String, default: null },
    pdfFileKey: { type: String, default: null },
    evidence: { type: [Schema.Types.Mixed], default: [] },
    submittedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: null },
    archiveReason: { type: String, default: null },
  },
  { timestamps: true, strict: false, collection: "invoices" }
);

// ---------------------------------------------------------------------------
// Bitácora
// ---------------------------------------------------------------------------

export interface IAuditLog {
  _id: Types.ObjectId;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  actorRole: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  comment: string | null;
  createdAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    entityType: String,
    entityId: String,
    action: String,
    actorId: String,
    actorRole: String,
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    comment: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { strict: false, collection: "auditLog", versionKey: false }
);

export interface IInvoiceEvent {
  _id: Types.ObjectId;
  invoiceFolio: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string;
  actorRole: string;
  comment: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

const InvoiceEventSchema = new Schema<IInvoiceEvent>(
  {
    invoiceFolio: String,
    fromStatus: { type: String, default: null },
    toStatus: String,
    actorId: String,
    actorRole: String,
    comment: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { strict: false, collection: "invoiceEvents", versionKey: false }
);

export interface IValidationResult {
  _id: Types.ObjectId;
  invoiceFolio: string;
  rule: string;
  severity: "BLOQUEANTE" | "ADVERTENCIA" | "INFO";
  passed: boolean;
  detail: string;
  automated: boolean;
  ranAt: Date;
}

const ValidationResultSchema = new Schema<IValidationResult>(
  {
    invoiceFolio: String,
    rule: String,
    severity: String,
    passed: Boolean,
    detail: String,
    automated: { type: Boolean, default: true },
    ranAt: { type: Date, default: Date.now },
  },
  { strict: false, collection: "validationResults", versionKey: false }
);

// ---------------------------------------------------------------------------
// Usuarios del portal
// ---------------------------------------------------------------------------
//
// CUIDADO: esta `users` es la de KPS-Proveedores, NO la de cronos-retail. Son
// esquemas incompatibles —aquí `roles[]` + `supplierCode`, allí `role` +
// `modules[]`— y viven en bases distintas. Escribir una creyendo que es la otra
// rompería el login de uno de los dos proyectos.

export interface IPortalUser {
  _id: Types.ObjectId;
  email: string;
  name: string;
  passwordHash: string | null;
  oidcSubject: string | null;
  roles: string[];
  supplierCode: string | null;
  active: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const PortalUserSchema = new Schema<IPortalUser>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    passwordHash: { type: String, default: null },
    oidcSubject: { type: String, default: null },
    roles: { type: [String], default: [] },
    supplierCode: { type: String, default: null },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, strict: false, collection: "users" }
);

// ---------------------------------------------------------------------------
// Archivos subidos por el proveedor
// ---------------------------------------------------------------------------
//
// El portal guarda los bytes en Mongo mientras no haya bucket de S3. El `_id`
// es la clave que las facturas referencian en `xmlFileKey` y `pdfFileKey`.

export interface IStoredDocument {
  _id: string;
  filename: string;
  contentType: string;
  size: number;
  bytes: Buffer;
  purpose: string;
  supplierCode: string | null;
  createdAt: Date;
}

const StoredDocumentSchema = new Schema<IStoredDocument>(
  {
    _id: { type: String, required: true },
    filename: String,
    contentType: String,
    size: Number,
    bytes: Buffer,
    purpose: String,
    supplierCode: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { strict: false, collection: "documents", versionKey: false, _id: false }
);

// ---------------------------------------------------------------------------
// Registro perezoso
// ---------------------------------------------------------------------------
//
// Se registran al primer uso y no al importar el módulo: la conexión se abre
// dentro de `connectProveedoresDB()`, y hacerlo en el cuerpo del import la
// abriría también al construir, cuando no hay MONGODB_URI.

function modelo<T>(nombre: string, schema: Schema<T>): Model<T> {
  const c = conn();
  return (c.models[nombre] as Model<T>) ?? c.model<T>(nombre, schema);
}

export const Supplier = () => modelo<ISupplier>("Supplier", SupplierSchema);
export const Invoice = () => modelo<IInvoice>("Invoice", InvoiceSchema);
export const AuditLog = () => modelo<IAuditLog>("AuditLog", AuditLogSchema);
export const InvoiceEvent = () => modelo<IInvoiceEvent>("InvoiceEvent", InvoiceEventSchema);
export const ValidationResult = () =>
  modelo<IValidationResult>("ValidationResult", ValidationResultSchema);
export const StoredDocument = () =>
  modelo<IStoredDocument>("StoredDocument", StoredDocumentSchema);
export const PortalUser = () => modelo<IPortalUser>("PortalUser", PortalUserSchema);
