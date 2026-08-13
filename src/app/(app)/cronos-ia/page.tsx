import { redirect } from "next/navigation";
import { AccesoDenegado } from "@/components/dashboard/AccesoDenegado";
import { ChatShell } from "@/components/chat/ChatShell";
import { getSessionUser } from "@/lib/auth/guards";
import { canAccess } from "@/lib/rbac";

// KPS AI (§9): pestaña con su propia ruta y guard de módulo. Es un
// módulo independiente — NO recibe datos de Retail como contexto.
export default async function CronosIaPage() {
  const usuario = await getSessionUser();
  if (!usuario) redirect("/login");
  if (!canAccess(usuario, "cronos-ia")) return <AccesoDenegado modulo="KPS AI" />;

  return <ChatShell />;
}
