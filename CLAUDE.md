@AGENTS.md
## Restricción: variables de entorno

Claude Code **no debe leer, imprimir, exportar ni modificar** variables de entorno bajo ninguna circunstancia, incluyendo pero no limitado a:

- Ejecutar `env`, `printenv`, `set`, `export` sin argumentos, o cualquier comando que liste variables de entorno.
- Leer archivos `.env`, `.env.local`, `.env.*`, `.envrc`, o cualquier archivo de configuración que contenga secretos/credenciales.
- Acceder a `process.env` (Node.js), `os.environ` (Python), `System.getenv` (Java/Kotlin), `ENV` (Ruby), o equivalentes en cualquier lenguaje, salvo para verificar que una clave *existe* (nunca para mostrar su valor).
- Incluir el valor de una variable de entorno en logs, mensajes de commit, PRs, código generado, o cualquier salida visible.
- Copiar, exportar o transmitir variables de entorno a servicios externos, scripts temporales o archivos nuevos.

## Excepciones permitidas

- Verificar si una variable **existe** (ej. `if os.environ.get("API_KEY") is None`) sin exponer su contenido.
- Referenciar el **nombre** de una variable en código (`process.env.DATABASE_URL`) sin ejecutar código que imprima su valor.
- Documentar en `README.md` o `.env.example` qué variables se requieren, usando valores placeholder (`API_KEY=your_key_here`).

## Si una tarea requiere el valor real de una variable

Claude Code debe **detenerse y pedir al usuario** que:
1. Confirme que la variable existe.
2. Realice él mismo cualquier acción que dependa del valor real (ej. probar una conexión con una API key).

No se debe asumir autorización implícita aunque la tarea parezca requerirlo (ej. "conecta con la base de datos" no autoriza imprimir `DATABASE_URL`).

## Archivos protegidos

Tratar como solo lectura / prohibidos para inspección de contenido:

```
.env
.env.*
*.pem
*.key
secrets/
config/credentials*
```

Claude Code puede confirmar que estos archivos existen (`ls`, `test -f`) pero no debe abrirlos ni mostrar su contenido.
