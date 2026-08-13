import { Resend } from "resend";

// Correo transaccional con Resend (§5.1). Cliente aislado aquí.

let client: Resend | null = null;

function resend() {
  if (client) return client;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY no está definida (ver .env.example)");
  client = new Resend(key);
  return client;
}

function from() {
  const f = process.env.EMAIL_FROM;
  if (!f) throw new Error("EMAIL_FROM no está definida (ver .env.example)");
  return f;
}

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  await resend().emails.send({
    from: from(),
    to,
    subject: "Restablecer contraseña — Cronos Retail",
    html: `
      <div style="font-family: ui-sans-serif, system-ui, sans-serif; color: #15171c; max-width: 480px; margin: 0 auto; padding: 24px;">
        <p style="font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #99a0ab; margin: 0 0 16px;">Arcanum — Cronos Retail</p>
        <h1 style="font-size: 20px; margin: 0 0 12px;">Restablecer contraseña</h1>
        <p style="font-size: 14px; color: #5a616c; line-height: 1.6;">
          Recibimos una solicitud para restablecer tu contraseña. El enlace expira en 30 minutos
          y solo puede usarse una vez.
        </p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="background: #15171c; color: #ffffff; padding: 12px 20px; text-decoration: none; font-size: 14px; border-radius: 2px; display: inline-block;">
            Crear nueva contraseña
          </a>
        </p>
        <p style="font-size: 12px; color: #99a0ab; line-height: 1.6;">
          Si no solicitaste este cambio, ignora este correo: tu contraseña actual sigue vigente.
        </p>
      </div>
    `,
  });
}
