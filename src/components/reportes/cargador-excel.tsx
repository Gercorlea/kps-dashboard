type Props = {
  onArchivo: (file: File) => void
  cargando: boolean
  nombreArchivo: string | null
}

export default function CargadorExcel({ onArchivo, cargando, nombreArchivo }: Props) {
  function alCambiar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Sin este reset, volver a elegir el MISMO archivo no dispara 'change'.
    e.target.value = ''
    if (file) onArchivo(file)
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* El input nativo no se puede estilizar; se oculta y el label hace de botón. */}
      <input
        id="archivo-excel"
        type="file"
        accept=".xlsx"
        className="sr-only"
        disabled={cargando}
        onChange={alCambiar}
      />
      <label
        htmlFor="archivo-excel"
        aria-busy={cargando}
        className={`inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity ${
          cargando
            ? 'cursor-progress opacity-60'
            : 'cursor-pointer hover:opacity-90 focus-within:ring-2 focus-within:ring-offset-2'
        }`}
      >
        {cargando && (
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        )}
        {cargando ? 'Leyendo archivo…' : 'Cargar archivo Excel'}
      </label>

      {nombreArchivo && !cargando && (
        <span className="text-sm text-zinc-600 dark:text-zinc-400">{nombreArchivo}</span>
      )}
    </div>
  )
}
