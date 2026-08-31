import bcrypt from "bcryptjs";
import type { Types } from "mongoose";
import { z } from "zod";
import { ApiError, handleApiError, ok, parseJson } from "@/lib/api";
import { requireModule } from "@/lib/auth/guards";
import { sapFetch } from "@/lib/sap/service-layer";
import { AuditLog, PortalUser, Supplier } from "@/models/proveedores";

// Alta de proveedores del portal (módulo `proveedores`).
//
// SAP manda en la identidad del proveedor —código, razón social, RFC— pero NO
// sabe lo único que el portal necesita para operarlo: si es de mercancía o de
// servicios. Esa distinción no existe en OCRD y decide todo el flujo posterior:
// el de mercancía factura contra una entrada, el de servicios factura sin orden
// de compra. Por eso el alta es elegir ese tipo, y por eso se guarda en Mongo y
// no en B1.

export const runtime = "nodejs";

const CAMPOS =
  "CardCode,CardName,CardType,GroupCode,Phone1,EmailAddress,CurrentAccountBalance,Currency,Valid,FederalTaxID,PayTermsGrpCode,UpdateDate";

interface SocioSap {
  CardCode: string;
  CardName: string;
  CardType?: string;
  GroupCode?: number | null;
  Phone1?: string | null;
  EmailAddress?: string | null;
  CurrentAccountBalance?: number | null;
  Currency?: string | null;
  Valid?: string | null;
  FederalTaxID?: string | null;
  PayTermsGrpCode?: number | null;
}

/**
 * Padrón completo de proveedores, cacheado en el proceso.
 *
 * Son ~430 socios en varias páginas y unos segundos contra la instancia de KPS.
 * Repetir eso al escribir en el buscador sería inaceptable. La búsqueda se hace
 * aquí y no con `$filter`: el `contains` de este Service Layer distingue
 * mayúsculas y no admite `toupper` —responde "Property 'toupper' of 'Document'
 * is invalid"—, así que buscar "biofarma" no encontraría "Biofarma Natural MD".
 */
const CACHE_MS = 60_000;
let cache: { at: number; items: SocioSap[] } | null = null;
let cargando: Promise<SocioSap[]> | null = null;

async function traerPadron(): Promise<SocioSap[]> {
  const todos: SocioSap[] = [];
  let skip = 0;
  for (;;) {
    const params = new URLSearchParams({
      $filter: "CardType eq 'cSupplier'",
      $select: CAMPOS,
      $orderby: "CardCode asc",
      $top: "100",
    });
    if (skip > 0) params.set("$skip", String(skip));
    const data = await sapFetch<{ value?: SocioSap[] }>(`/BusinessPartners?${params}`, {
      // Sin esta cabecera el Service Layer devuelve 20 filas por respuesta
      // (PageSize de b1s.conf) aunque el $top pida 100, y el padrón se queda
      // corto en silencio.
      headers: { Prefer: "odata.maxpagesize=100" },
    });
    const filas = data.value ?? [];
    todos.push(...filas);
    if (filas.length < 100) break;
    skip += filas.length;
    // Tope de seguridad: si algo va mal con la paginación, mejor cortar que
    // quedarse dando vueltas contra B1.
    if (todos.length >= 5000) break;
  }
  return todos;
}

async function padron(refrescar: boolean): Promise<SocioSap[]> {
  if (!refrescar && cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  cargando ??= traerPadron()
    .then((items) => {
      cache = { at: Date.now(), items };
      return items;
    })
    .finally(() => {
      cargando = null;
    });
  return cargando;
}

/** Minúsculas y sin acentos: quien busca "pena" espera encontrar "Peña". */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export async function GET(req: Request) {
  try {
    await requireModule("proveedores-alta");

    const url = new URL(req.url);
    const q = normalizar(url.searchParams.get("q")?.trim() ?? "");
    const refrescar = url.searchParams.get("refrescar") === "1";
    const limite = Math.min(Math.max(Number(url.searchParams.get("limite") ?? 50), 1), 200);

    const lista = await padron(refrescar);

    const [registrados, accesos] = await Promise.all([
      Supplier()
        .find({ supplierCode: { $type: "string" } }, { supplierCode: 1, type: 1, status: 1 })
        .lean(),
      // Los correos de acceso ya dados de alta. Sin esto la pantalla mostraba el
      // campo vacío aunque el acceso existiera, y parecía que no se había
      // guardado: es lo que lleva a crear un segundo correo para el mismo
      // proveedor sin querer.
      PortalUser()
        .find({ supplierCode: { $type: "string" } }, { email: 1, supplierCode: 1, active: 1 })
        .lean(),
    ]);

    const porCodigo = new Map(
      registrados.map((s) => [String(s.supplierCode), { type: s.type, status: s.status }])
    );
    const correosPorCodigo = new Map<string, string[]>();
    for (const u of accesos) {
      const c = String(u.supplierCode);
      correosPorCodigo.set(c, [...(correosPorCodigo.get(c) ?? []), u.email]);
    }

    const filtrados = q
      ? lista.filter((bp) =>
          [bp.CardCode, bp.CardName ?? "", bp.FederalTaxID ?? ""].some((c) =>
            normalizar(c).includes(q)
          )
        )
      : lista;

    return ok({
      total: lista.length,
      registrados: porCodigo.size,
      coinciden: filtrados.length,
      proveedores: filtrados.slice(0, limite).map((bp) => ({
        cardCode: bp.CardCode,
        nombre: bp.CardName,
        rfc: bp.FederalTaxID ?? null,
        moneda: bp.Currency ?? null,
        saldo: bp.CurrentAccountBalance ?? null,
        activoEnSap: bp.Valid !== "tNO",
        portal: porCodigo.get(bp.CardCode) ?? null,
        accesos: correosPorCodigo.get(bp.CardCode) ?? [],
      })),
    });
  } catch (e) {
    return handleApiError(e);
  }
}

/** Mínimo para la contraseña de un proveedor externo. */
const PASSWORD_MINIMA = 8;

const EsquemaAlta = z.object({
  cardCode: z.string().trim().min(1),
  type: z.enum(["MERCANCIA", "SERVICIO"]),
  // Opcionales: traer el proveedor de B1 y darle acceso al portal son dos
  // decisiones distintas, y KPS puede querer la primera sin la segunda.
  email: z.string().trim().email().optional().or(z.literal("")),
  password: z.string().optional(),
});

/**
 * El rol sigue al TIPO de proveedor y no se elige aparte. Un proveedor de
 * mercancía con rol de servicios vería un portal que no le corresponde, y
 * dejarlos elegir por separado hace posible esa combinación.
 */
function rolDeTipo(type: "MERCANCIA" | "SERVICIO"): string {
  return type === "SERVICIO" ? "PROVEEDOR_SERVICIO" : "PROVEEDOR_MERCANCIA";
}

/**
 * RFC que el SAT reserva y que varios proveedores comparten legítimamente:
 * público en general y residentes en el extranjero. No identifican a nadie, así
 * que quedan fuera del índice único de RFC del portal.
 */
const RFC_GENERICOS = ["XAXX010101000", "XEXX010101000"];

export async function POST(req: Request) {
  try {
    const usuario = await requireModule("proveedores-alta");
    const { cardCode, type, email: emailBruto, password } = await parseJson(req, EsquemaAlta);
    const email = (emailBruto ?? "").trim().toLowerCase();

    const lista = await padron(false);
    const bp = lista.find((s) => s.CardCode === cardCode);
    if (!bp) {
      throw new ApiError(
        404,
        "NO_ENCONTRADO",
        `Business One no tiene ningún proveedor con código ${cardCode}.`
      );
    }

    // Sin RFC no se puede validar ninguna factura: la regla RFC_EMISOR compara
    // el emisor del CFDI contra este campo. Además `taxId` es único en el
    // portal, y varios proveedores con RFC vacío chocarían entre sí.
    const taxId = (bp.FederalTaxID ?? "").trim().toUpperCase();
    if (!taxId) {
      throw new ApiError(
        422,
        "SIN_RFC",
        `${cardCode} no tiene RFC en Business One (FederalTaxID vacío). Captúralo en SAP y vuelve a intentarlo.`
      );
    }

    // --- Acceso al portal ---------------------------------------------------
    // Se resuelve ANTES de tocar nada: si el correo o la contraseña están mal,
    // no debe quedar el proveedor a medio registrar.
    let plan: {
      email: string;
      passwordHash: string | null;
      creado: boolean;
      /** Id del acceso que ya tenía el proveedor, cuando hay que renombrarlo. */
      renombrar: { id: Types.ObjectId; desde: string } | null;
    } | null = null;
    if (email) {
      const usuarioAnterior = await PortalUser().findOne({ email }).lean();

      // UN PROVEEDOR, UN CORREO. El acceso se busca por `supplierCode` y no solo
      // por correo: el formulario trae el correo actual precargado, así que
      // escribir otro significa CAMBIARLO, no añadir un segundo. Haciendo upsert
      // por correo, ese cambio creaba una cuenta nueva y el proveedor acababa
      // con dos accesos vivos —cada uno con su contraseña— sin que nadie lo
      // pidiera.
      const accesoActual = await PortalUser().findOne({ supplierCode: cardCode }).lean();

      // Que el correo exista no basta para reutilizarlo: si pertenece a otra
      // cuenta —un interno de KPS, u otro proveedor— reescribirle los roles la
      // convertiría en la cuenta de este proveedor. Escribir "admin@kps.com"
      // aquí degradaría al administrador a proveedor.
      if (usuarioAnterior && usuarioAnterior.supplierCode !== cardCode) {
        throw new ApiError(
          409,
          "CORREO_EN_USO",
          `El correo ${email} ya pertenece a otra cuenta del portal. Usa uno distinto para ${cardCode}.`
        );
      }
      // Solo hace falta contraseña cuando no hay ninguna cuenta detrás: ni con
      // este correo ni la que el proveedor ya tenía con otro. Renombrar un
      // acceso conserva su contraseña.
      if (!usuarioAnterior && !accesoActual && !password) {
        throw new ApiError(422, "FALTA_PASSWORD", "Para crear el acceso hace falta una contraseña.");
      }
      if (password && password.length < PASSWORD_MINIMA) {
        throw new ApiError(
          422,
          "PASSWORD_CORTA",
          `La contraseña debe tener al menos ${PASSWORD_MINIMA} caracteres.`
        );
      }

      const renombrar =
        accesoActual && accesoActual.email !== email
          ? { id: accesoActual._id, desde: accesoActual.email }
          : null;

      plan = {
        email,
        // bcrypt tarda décimas de segundo: se hace aquí, antes de escribir.
        passwordHash: password ? await bcrypt.hash(password, 12) : null,
        creado: !usuarioAnterior && !renombrar,
        renombrar,
      };
    } else if (password) {
      throw new ApiError(
        422,
        "FALTA_CORREO",
        "La contraseña sola no sirve: escribe también el correo de acceso."
      );
    }

    const anterior = await Supplier().findOne({ supplierCode: cardCode }).lean();

    // Si KPS lo bloqueó por un recibo de pago pendiente, refrescar desde SAP no
    // debe desbloquearlo por la puerta de atrás.
    const status = anterior?.blocked ? "BLOQUEADO" : bp.Valid === "tNO" ? "INACTIVO" : "ACTIVO";

    try {
      await Supplier().updateOne(
        { supplierCode: cardCode },
        {
          $set: {
            legalName: bp.CardName,
            taxId,
            // Lo que lleva el índice único. Queda en null en los RFC genéricos
            // —`XAXX010101000` y `XEXX010101000`, que varios proveedores
            // comparten legítimamente— para que el segundo que aparezca no
            // choque contra el primero. Ver `taxIdUnico` en el portal.
            taxIdUnique: RFC_GENERICOS.includes(taxId) ? null : taxId,
            contact: { correo: bp.EmailAddress ?? null, telefono: bp.Phone1 ?? null },
            currency: bp.Currency ?? null,
            groupCode: bp.GroupCode ?? null,
            sapValid: bp.Valid !== "tNO",
            status,
            type,
            syncedAt: new Date(),
          },
          // Lo que solo sabe el portal no se toca al refrescar: el bloqueo, los
          // servicios dados de alta y el expediente de alta.
          $setOnInsert: {
            supplierCode: cardCode,
            fiscalAddress: {},
            paymentTerms: "",
            blocked: false,
            services: [],
            onboarding: null,
          },
        },
        { upsert: true }
      );
    } catch (e) {
      // El índice único de `taxIdUnique` es lo que impide tener el mismo RFC
      // dos veces. "E11000 duplicate key" no le dice nada a quien da de alta.
      //
      // Ya no salta con los RFC genéricos: esos quedan fuera del índice, así que
      // llegar aquí significa que DE VERDAD hay dos proveedores con el mismo RFC
      // real, que es el error que este mensaje existe para explicar.
      if (typeof e === "object" && e && (e as { code?: number }).code === 11000) {
        throw new ApiError(
          409,
          "RFC_DUPLICADO",
          `El RFC ${taxId} ya está registrado en el portal con otro código de proveedor.`
        );
      }
      throw e;
    }

    if (plan) {
      const datos = {
        name: bp.CardName,
        roles: [rolDeTipo(type)],
        supplierCode: cardCode,
        active: true,
        ...(plan.passwordHash ? { passwordHash: plan.passwordHash } : {}),
      };
      try {
        if (plan.renombrar) {
          // Se le cambia el correo AL MISMO acceso. Nada de upsert aquí: crear
          // por correo es justo lo que dejaba dos cuentas para un proveedor.
          await PortalUser().updateOne(
            { _id: plan.renombrar.id },
            { $set: { ...datos, email: plan.email } }
          );
        } else {
          await PortalUser().updateOne(
            { email: plan.email },
            {
              $set: datos,
              $setOnInsert: { email: plan.email, oidcSubject: null, lastLoginAt: null },
            },
            { upsert: true }
          );
        }
      } catch (e) {
        if (typeof e === "object" && e && (e as { code?: number }).code === 11000) {
          throw new ApiError(
            409,
            "CORREO_EN_USO",
            `El correo ${plan.email} ya pertenece a otra cuenta del portal.`
          );
        }
        throw e;
      }

      await AuditLog().create({
        entityType: "user",
        entityId: plan.email,
        action: plan.creado
          ? "USUARIO_CREADO"
          : plan.renombrar
            ? "USUARIO_RENOMBRADO"
            : "USUARIO_ACTUALIZADO",
        actorId: usuario.id,
        actorRole: usuario.role,
        before: null,
        // Nunca el hash ni la contraseña: la bitácora la leen personas.
        after: { roles: [rolDeTipo(type)], supplierCode: cardCode },
        comment: plan.renombrar
          ? `Acceso de ${cardCode}: el correo pasa de ${plan.renombrar.desde} a ${plan.email}.`
          : plan.passwordHash
            ? `Acceso al portal para ${cardCode}, con contraseña nueva.`
            : `Acceso al portal para ${cardCode}, sin cambiar la contraseña.`,
        createdAt: new Date(),
      });
    }

    await AuditLog().create({
      entityType: "supplier",
      entityId: cardCode,
      action: anterior ? "SUPPLIER_REFRESCADO" : "SUPPLIER_REGISTRADO",
      actorId: usuario.id,
      actorRole: usuario.role,
      before: anterior ? { type: anterior.type, status: anterior.status } : null,
      after: { type, status },
      comment: anterior
        ? `Datos actualizados desde Business One. Tipo: ${type}.`
        : `Proveedor traído de Business One como ${type}.`,
      createdAt: new Date(),
    });

    return ok(
      {
        creado: !anterior,
        proveedor: { cardCode, nombre: bp.CardName, rfc: taxId, type, status },
        acceso: plan
          ? {
              email: plan.email,
              creado: plan.creado,
              renombradoDesde: plan.renombrar?.desde ?? null,
              passwordActualizada: plan.passwordHash !== null,
            }
          : null,
      },
      { status: anterior ? 200 : 201 }
    );
  } catch (e) {
    return handleApiError(e);
  }
}
