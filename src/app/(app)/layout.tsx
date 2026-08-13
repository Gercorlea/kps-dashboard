import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { getSessionUser } from "@/lib/auth/guards";
import { connectDB } from "@/lib/db";
import { User } from "@/models/User";

// Layout del dashboard autenticado (§2). El proxy ya hizo el check
// optimista; aquí se relee sesión y usuario para armar el shell.
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionUser();
  if (!session) redirect("/login");

  await connectDB();
  const user = await User.findById(session.id)
    .select({ name: 1, role: 1, modules: 1, active: 1 })
    .lean();
  if (!user || !user.active) redirect("/login");

  const usuario = {
    id: String(user._id),
    name: user.name,
    role: user.role,
    modules: user.modules.map(String),
  };

  return (
    <div className="cr-shell">
      <Sidebar usuario={usuario} />
      <main className="cr-shell__main">{children}</main>
    </div>
  );
}
