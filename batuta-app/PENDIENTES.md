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

## Auditoría de promesas (24-oct-2026): lo que se cerró y lo que sigue pendiente
Rama `cumplir-promesas-24oct`. Cerrado en código: respaldo del servidor + chat en el export, avisos al profe
(chat, reserva, cancelación) con contador de no leídos, embudo que avanza solo + conversión, liquidación
cerrada/pagada/Caja, recordatorios para plan gratis + segundo aviso al vencer + aviso de correo apagado,
recibo correlativo + envío automático + visible en el portal.

### Pendiente (no se hizo a propósito)
- **«Borrar mi cuenta y mis datos»:** NO existe. Borrar una academia toca ~25 tablas más archivos en R2 y
  sesiones, y un error ahí es irreversible con academias reales (Elevate, MVT). Requiere diseño aparte:
  doble confirmación, descarga previa del respaldo (`/app/api/admin/backup/ahora`), borrado por `tenant_id`
  en transacción, purga de R2 por prefijo y de `push_subs`/`sesiones`. Hoy se hace a mano con el superadmin.
- **Boleta SUNAT (Nubefact):** no se tocó. Falta: (1) que cada academia cree SU cuenta Nubefact y pegue ruta +
  token + RUC en Ajustes (hoy ninguna lo hizo y nunca se recorrió con un documento real); (2) FACTURAS (solo hay
  boletas); (3) NOTAS DE CRÉDITO y anulaciones; (4) emisión automática al confirmar el pago (hoy es a mano,
  pago por pago). El «recibo» es un comprobante NO tributario y así lo dice.
- **Backup automático diario:** el cron no respalda. `backup/ahora` ya guarda en R2 (`backups/<tenant>/<fecha>.json`)
  si hay binding; falta llamarlo desde `scheduled()` (decisión de Andrés: costo de R2 y retención).
- **Cobro recurrente automático al alumno, recordatorios por WhatsApp, dominio propio por academia, app en
  tiendas, editor de landing separado PC/celular, audios del bot:** no se hacen por código ahora (ver
  `batuta-textos-honestos.md` en el Second Brain para cómo se describen mientras tanto).
- Pruebas que ya fallaban ANTES de estos cambios (13): aforo-se-ve, api-mismo-numero, carrera-reserva,
  dos-clases-el-mismo-dia, estados-raros, historia-no-se-mueve, importador-no-adivina, pase-vencido-se-nota,
  pausa-no-inventa-vencimiento, portal-agenda-multipase, renovacion-columnas, reprogramar-cuenta, tres-superficies.
  `./correr-pruebas-mjs.sh` corre todas y lista las que fallan.

## «Mi web»: arrastrar y estirar textos (24-oct-2026)
Hecho: títulos, párrafos y el botón de la portada se mueven (mouse y dedo) dentro de su sección o a otra, se estiran en ancho/alto
(medidas de PC y de celular por separado), con «Paso atrás» y «Volver a como estaba». Se guarda en `web.layout` (dentro de `config.web_json`,
SIN tablas ni columnas nuevas). Sin `layout`, la web pública sale idéntica byte por byte (`pruebas-mi-web-compatible.mjs`).
Pruebas: `pruebas-mi-web-layout.mjs` (datos y render), `pruebas-mi-web-compatible.mjs`, `pruebas-mi-web-arrastrar.e2e.mjs` (Playwright contra
`wrangler dev --local`; mouse y touch). Límites: no se mueven fotos ni tarjetas de cursos/precios (son un módulo fijo dentro de su sección);
las medidas de alto son «alto mínimo»; sin editor separado de PC y celular (el orden es el mismo, el tamaño no).
Ojo al desplegar: el bundler agrega `__name`; el script del editor ya lo define (si se vuelve a mover ese script, conservar esa línea).

## Asistente (MCP/API) que cambia precios (25-oct-2026)
Hecho: `listar_precios` y `actualizar_precio` (ver RUNBOOK, «Hablar con tu academia desde Claude o ChatGPT»). Llave de escritura aparte, apagada por defecto, bitácora `api_cambios`, tope y validaciones.
Pendiente / límites: (1) no crea ni borra paquetes ni cambia otros datos (alumnos, pagos, planes) por diseño; (2) falta probar con un cliente real de Claude y de ChatGPT, y confirmar qué planes de ChatGPT permiten conectores MCP con escritura; (3) la llave va en la URL: si se quiere más seguridad, pasar a OAuth por academia; (4) el tope de 20 cambios/hora y el límite de 3x son valores a ajustar con uso real; (5) «deshacer» el último cambio desde el panel no existe: se revierte pidiendo el precio anterior.
