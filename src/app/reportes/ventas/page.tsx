import type { Metadata } from 'next'
import VentasCliente from '@/components/reportes/ventas-cliente'

export const metadata: Metadata = {
  title: 'Reporte de ventas',
  description: 'Carga un Excel de ventas y analiza los datos en el navegador.',
}

export default function Page() {
  // flex-1 porque el layout raíz pone `min-h-full flex flex-col` en el body.
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-6 py-10 font-sans">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Reporte de ventas</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Carga un archivo .xlsx para ver los datos en crudo y su análisis.
        </p>
      </header>

      <VentasCliente />
    </main>
  )
}
