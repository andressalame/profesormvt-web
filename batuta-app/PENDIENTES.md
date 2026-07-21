# Batuta App v0 — apagado a propósito / pendientes para v1

> Escrito por Fable tras la revisión del backend (06-jul-2026). El criterio v0: todo lo que dependa de
> credenciales por-cliente o servicios externos queda APAGADO con guard limpio, no a medias.

## Apagado en v0 (con guard, no roto)
- **Mercado Pago (tarjeta automática):** endpoints /app/api/mp/* no existen; el portal solo ofrece
  Yape/Plin/transferencias/crypto con confirmación manual del profesor. Se conecta al activar plan (fase 2: OAuth por tenant).
- **Google Calendar + Meet:** sin credenciales por tenant; la agenda funciona con la disponibilidad interna
  y el índice único anti doble-reserva. Fase 2: OAuth por tenant.
- **Correos (Resend):** enviarCorreo degrada a false sin RESEND_API_KEY. Sin bienvenidas/recordatorios por correo en v0.
- **Web Push:** sin VAPID; no-op.
- **Chatbot y IA de onboarding:** sin bindings/API key; responden fallback/501.
- **R2 (adjuntos/ejercicios/backups):** sin binding; subir archivos responde "no disponible" y el resto funciona.
- **Reset de contraseña de alumno por correo:** apagado (depende de Resend); el portal dice "escríbele a tu profesor".
  El PROFESOR resetea claves de alumnos desde su panel, como en el core.
- **Crons:** scheduled() vacío (sin recordatorios de clase, renovaciones, win-back, nurture, backups).

## Cosas a saber de v0
- **Tenant nuevo arranca SIN disponibilidad configurada:** hasta que el profesor marque sus horarios en
  Agenda, sus alumnos no ven slots. Considerar sembrar una disponibilidad default (L-S 9-12/14-20) en t/registro,
  o un aviso claro en el panel. (Mejora rápida candidata.)
- **Cobro del plan del tenant es manual:** el superadmin (Andrés) activa/extiende/vence tenants vía
  /app/api/su/* con ADMIN_TOKEN. No hay cobro recurrente automatizado todavía.
- **Tenant nuevo arranca con PRECIOS de música sembrados** (250/450/600/70/50 en la tabla `precios`,
  worker/index.js ~4488 registro público y ~4399 alta por Google). Una academia que no sea de música ve
  esos precios en su panel hasta que los edite. Candidato: sembrar en 0 y cambiar `preciosPropios` del
  checklist de activación (~4613) a `some(k => precios[k] > 0)`, dejando la demo con defaults a propósito.
  Mientras tanto, `crear-fundador.sh --precios-cero` lo evita en las cuentas armadas a mano. (20-jul-2026)
- **Sin Turnstile en t/registro:** hay rate limit 5/h por IP; suficiente para v0, captcha en v1.
- **Queries globales justificadas:** sesiones por token (aleatorio 64-hex), tenants por email/slug (login/registro/público),
  reset_tokens por hash (aleatorio), chatbot_uso y onboarding_ia_uso (rate limit por IP/clave). Todo lo demás lleva tenant_id.

## Para v1 (cuando haya tenants pagando)
- OAuth de Mercado Pago y Google Calendar por tenant (la fase 2 del análisis de siempre).
- Correos transaccionales con dominio batuta.lat verificado en Resend.
- Cobro recurrente del plan (MP suscripciones) + corte automático.
- Migrar MVT y Nicole al core multi-tenant ("patch para todos").

## Producto por nicho — lo que falta tras la sesión del 14-jul-2026
- **Módulos en el PORTAL DEL ALUMNO:** modulos_off hoy solo oculta en el panel del profe. Si el profe
  apaga Chat o Material, el alumno todavía ve esas secciones (vacías). Falta: exponer modulos_off en
  /app/api/publico y /app/api/me y ocultar en el portal. Ojo con agenda: NO se hizo apagable a propósito
  (demasiados tentáculos en reservas/recordatorios).
- **Presets por vertical:** el mecanismo (config vertical + terminos + modulos_off default por rubro) está
  diseñado en el vault (proyectos/Batuta - producto por nicho (plan 2026-07-14).md). Falta que Andrés apruebe
  los términos por rubro; luego son ~2-3 sesiones (diccionario T() + data-t + copy del worker + prompt del bot).
- **Demo por vertical:** Estudio Sonata es de música; un prospecto de fútbol ve demo de música.
