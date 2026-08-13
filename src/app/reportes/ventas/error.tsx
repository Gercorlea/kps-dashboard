'use client' // Los error boundaries tienen que ser Client Components

import { useEffect } from 'react'

// Next 16 pasa `unstable_retry`, no `reset` como en versiones anteriores.
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-start gap-4 px-6 py-10 font-sans">
      <h1 className="text-2xl font-semibold">Algo salió mal</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        No se pudo mostrar el reporte. Vuelve a intentarlo o carga el archivo de nuevo.
      </p>
      <button
        type="button"
        onClick={() => unstable_retry()}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
      >
        Reintentar
      </button>
    </main>
  )
}
