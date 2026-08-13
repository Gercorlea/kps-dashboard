import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Cloudflare R2 vía API S3-compatible (§5.7). El SDK vive SOLO aquí: el
// resto de la app llama estas funciones, nunca instancia el cliente.
//
// Clasificación de archivos:
//   - private/  → confidencial (los Excel del cliente). Solo presigned GET
//     de vida corta emitido por un endpoint autenticado con RBAC.
//   - public/   → servible por R2_PUBLIC_URL (nada en v1, mecanismo listo).

let client: S3Client | null = null;

function r2() {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("Faltan credenciales de R2 (ver .env.example)");
  }
  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

function bucket() {
  const b = process.env.R2_BUCKET;
  if (!b) throw new Error("R2_BUCKET no está definida (ver .env.example)");
  return b;
}

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function sanitizeFilename(filename: string): string {
  return filename.replace(/[^\w.\-()\s]/g, "_").replace(/\s+/g, " ").trim();
}

export function claveExcelPrivada(uploadId: string, filename: string): string {
  return `private/retail/${uploadId}/${sanitizeFilename(filename)}`;
}

// Presigned PUT para subida directa desde el navegador (5 min).
export async function getUploadUrl(
  key: string,
  contentType: string,
  contentLength: number
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: bucket(),
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  return getSignedUrl(r2(), cmd, { expiresIn: 300 });
}

// Presigned GET de vida corta (120s) para objetos confidenciales.
export async function getDownloadUrl(key: string, downloadName?: string): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: bucket(),
    Key: key,
    ...(downloadName
      ? {
          ResponseContentDisposition: `attachment; filename="${sanitizeFilename(downloadName)}"`,
        }
      : {}),
  });
  return getSignedUrl(r2(), cmd, { expiresIn: 120 });
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await r2().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!res.Body) throw new Error(`Objeto vacío en R2: ${key}`);
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
}

export async function deleteObject(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

// SOLO para el prefijo público. Nunca construir a mano URL pública de un
// objeto confidencial (§5.7).
export function publicUrl(key: string): string {
  if (!key.startsWith("public/")) {
    throw new Error(`publicUrl solo aplica al prefijo public/: ${key}`);
  }
  const base = process.env.R2_PUBLIC_URL;
  if (!base) throw new Error("R2_PUBLIC_URL no está definida (ver .env.example)");
  return `${base.replace(/\/$/, "")}/${key}`;
}
