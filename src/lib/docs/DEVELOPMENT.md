# Desarrollo — Cronos Retail

## Puesta en marcha

```bash
cp .env.example .env.local   # completa al menos MONGODB_URI, JWT_* y el seed
npm install
npm run seed:superadmin      # crea el superadmin inicial (falla si ya existe)
npm run dev
```

## Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | servidor de desarrollo |
| `npm run build` / `start` | build y servidor de producción |
| `npm test` | Vitest (lógica: parser, marcas, guards, Zod, métricas) |
| `npm run lint` | ESLint |
| `npm run seed:superadmin` | crea el superadmin desde env |

## Git y commits

- Rama `main` protegida mentalmente: se trabaja en ramas por feature
  (`feat/…`, `fix/…`) y se integra con PR.
- Convención de commits: **Conventional Commits** (`feat:`, `fix:`, `docs:`,
  `refactor:`, `test:`, `chore:`). El repo trae `commitizen`
  (`npm run commit`) y hooks de `husky` + `lint-staged` (ESLint al commitear).
- `package-lock.json` va commiteado; el gestor es **npm** (no pnpm/yarn).

## Testing

- **Vitest** + Testing Library. Se testea **lógica, nunca diseño** (ni colores
  ni márgenes): guards/RBAC, schemas Zod, el parser con las seis trampas del
  archivo real, el catálogo de marcas y las métricas con divisor cero.
- Los tests del parser construyen workbooks sintéticos con SheetJS; no
  necesitan MongoDB ni red. `npm test` debe pasar antes de cualquier PR.

## Convenciones de código

- TypeScript `strict`; imports con alias `@/` → `src/`.
- Todo boundary de API valida con Zod antes de tocar la DB y responde el
  contrato `{ ok, data } | { ok, error }`.
- Textos de UI en español; código y nombres de campos en el idioma del dominio
  (es) consistente con los modelos.
- Nada de SDKs de proveedores de IA directos: solo `lib/ai.ts` (Gateway).
- CSS: tokens y clases `.cr-*` de `design-system.css`; Tailwind para layout.
  Reglas visuales completas en `lib/docs/DESIGN.md`.
