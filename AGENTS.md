<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Qué NO se debe subir a GitHub

Estos archivos nunca deben commitearse ni pushearse (el `.gitignore` ya bloquea la mayoría — no lo debilites):

- **Secretos y credenciales**: `.env` y cualquier variante (`.env.local`, `.env.production`, …). Ahí van la URI de MongoDB, las claves de AWS S3, la API key de Resend y los secretos JWT. Si un secreto se sube por accidente, hay que rotarlo (cambiarlo), no solo borrar el archivo.
- **Certificados y llaves**: `*.pem`, llaves privadas en general.
- **Dependencias y builds**: `node_modules/`, `.next/`, `out/`, `build/`, `coverage/`, `*.tsbuildinfo`.
- **Archivos de datos reales**: Excel/CSV con datos de producción o información personal (el dashboard procesa hojas de cálculo con `xlsx`). Solo se permiten datos de ejemplo/sintéticos.
- **`package-lock.json`**: este proyecto usa **pnpm** (`pnpm-lock.yaml` es el lockfile que sí se commitea). El `package-lock.json` es un sobrante de npm y debe eliminarse, no actualizarse.
- **Configuración local personal**: `.claude/settings.local.json`, `.vercel/`, logs de debug.

Regla general: antes de commitear, revisar `git status` y preguntarse si cada archivo nuevo contiene secretos o datos reales.
