# RUNBOOK — construir Batuta App v0 (corrida nocturna autónoma)

> Para la sesión programada de las 3:10am del 04-jul-2026 (tras el reset del límite de sesión).
> Contexto completo del producto en SPEC.md (mismo directorio). Este runbook es el plan de ejecución.

## Estado actualizado (Fable, madrugada del 06-jul)
- **YA HECHO, no repetir:** db/schema.sql (17 tablas, tenant_id integrado, validado con `sqlite3` — el archivo
  compila sin errores) y wrangler.toml (name batuta-app, main worker/index.js, assets ./public, D1 binding DB
  con database_id="PENDIENTE" a rellenar recién al crear la D1 real).
- worker/index.js, public/panel/index.html, public/alumnos/index.html: SIGUEN siendo copias intactas del core
  de MVT. Es lo que falta transformar (agentes A y B de prompts-agentes.md).
- **wrangler dev/d1 --local NO CORRE en esta máquina** (macOS 12.6.0, el runtime workerd pide 13.5.0+). Para
  validar SQL usa `sqlite3 archivo.db < schema.sql` (rápido, ya confirmado que funciona). Para probar el worker
  de verdad no hay atajo local: hay que crear la D1 remota y deployar (pasos 4 de abajo) y probar contra la URL
  real de workers.dev — hazlo recién después de que ambos agentes terminen y pasen tu revisión de código.
- El sitio batuta.lat (repo ~/Code/batuta) ya tiene los CTAs apuntando a /demo. NO tocarlo en esta tanda.

## Qué hacer (en orden)
1. Lanzar DOS subagentes Sonnet EN PARALELO (ya hay usage de nuevo). Prompts: son largos y precisos,
   están guardados en batuta-app/prompts-agentes.md (agente A = backend, agente B = paneles). Pásalos tal cual.
   Ambos deben leer SPEC.md primero. Modelo: sonnet, effort high, en background.
2. Cuando terminen ambos: pase de integración TÚ MISMO (o un tercer agente Sonnet):
   - node --check batuta-app/worker/index.js y de los <script> extraídos de ambos HTML.
   - Coherencia de contrato: los paneles llaman /app/api/... y el worker los sirve; el token es 'batuta_t';
     el slug viene de /app/a/<slug>; el 402 dispara paywall.
   - Grep anti-fugas: TODAS las queries (env.DB.prepare) con tenant_id o justificadas como globales.
3. Prueba local: cd batuta-app && npx wrangler d1 execute batuta-app --local --file db/schema.sql &&
   npx wrangler dev --local --port 8791 (background) + curl: t/registro → t/me → crear alumno → segundo tenant
   NO ve al primero → publico?slug=. Matar el dev server al final. Si el runtime local no corre en este macOS
   viejo, compensar con auditoría de queries y anotarlo.
4. Deploy AISLADO (no toca nada existente): npx wrangler d1 create batuta-app (capturar database_id →
   wrangler.toml) → npx wrangler d1 execute batuta-app --remote --file db/schema.sql →
   npx wrangler secret put ADMIN_TOKEN --name batuta-app (generar con openssl rand -hex 24 y GUARDAR el valor
   en batuta-app/.admin-token.local, agregado a .gitignore) → npx wrangler deploy (desde batuta-app/).
   Smoke test contra la URL workers.dev: registro de tenant de prueba + t/me + 402 simulado si es fácil.
5. NO tocar batuta.lat ni vercel.json esta noche (el cableado /app → worker se hace en la mañana con Andrés).
6. Commit de batuta-app/ en el repo mvt (git add batuta-app && commit; el push dispara el deploy de MVT por la
   Action pero el worker de MVT no cambió, es inofensivo). Mensaje claro.
7. Dejar resumen en batuta-app/RESULTADO.md: qué quedó vivo (URL workers.dev), qué falló, pendientes.
   Actualizar memoria (~/.claude/projects/-Users-andres-Desktop-Second-Brain/memory/proyecto-batuta.md) con 3 líneas.

## Reglas
- El core de MVT en producción NO SE TOCA (nada fuera de batuta-app/ salvo el commit).
- Si algo no se puede scoped-ear con confianza: se APAGA con guard y va a PENDIENTES.md. Cero riesgo de fuga entre tenants.
- Presupuesto: si a las 2 horas no está integrando, cortar, commitear lo que compile y documentar en RESULTADO.md.

## Feedback con premio (09-jul-2026)
- Los tenants mandan errores/ideas desde el panel (Configuración → Ideas y errores) o desde el paywall si vencieron.
- El PRIMER aporte de cada mes calendario premia +7 días de acceso (trial_hasta). El vencido revive a 'trial'.
  El activo conserva su estado; los días quedan de colchón si algún día cancela (el webhook respeta trial_hasta futura).
- Cada aporte te llega por correo (alertaCorreoAndres). Tope: 10 aportes/tenant/mes + rate limit IP.
- Ver todos: curl -s https://batuta.lat/app/api/su/feedback -H "Authorization: Bearer $(cat .admin-token.local)"
- Marcar estado: curl -X POST .../app/api/su/feedback -d '{"id":"<id>","estado":"visto|hecho|nuevo"}' (mismo Bearer).

## Multi-profesor (09-jul-2026) — ACTIVO
- Tenant = ACADEMIA. Dueno (rol 'dueno') ve todo; cada profesor entra con su correo/contrasena y ve SOLO sus alumnos, agenda, horarios, grupos, chat y pagos. Sesiones: 'P:'+profesor_id (T: legacy = dueno).
- Asientos por plan: profe=1, academia=5, xl=20 (candado en invitar; 402 con upsell).
- Invitar: panel del dueno → Personas → Profesores → correo con link /app/p/activar?token=... (o copiar link).
- Blindados los DELETE-by-tenant: data PUT y disponibilidad POST scoped por profesor. El PUT ademas preserva vence/avisos/profesor_id server-side (antes se reseteaban).
- Migraciones ya corridas en prod: su/migrar-disponibilidad (PK por profesor; tabla vieja respaldada como disponibilidad_legacy_v1) + su/migrar-profesores (idempotente, re-correr si aparecen filas huerfanas).

## Recordatorios automaticos (09-jul-2026) — ACTIVOS
- Cron UNICO cada 15 min (limite de 5 crons/cuenta en plan free): recordatorios de clase (24h y 1h antes, columnas aviso_24/aviso_1h) siempre; a las 14:00 UTC ademas nurture + renovaciones (vence −3d a +3d, 1 por ciclo via aviso_vence_ciclo) + reset demo.
- Toggles por tenant en Ajustes: recordatorios_clase / recordatorio_renovacion ('' = ON, 'off' = apagado). Demo y tenants vencidos jamas mandan. Sin RESEND_API_KEY degrada mudo.
- Probar a demanda: curl -X POST https://batuta.lat/app/api/su/correr-recordatorios -H "Authorization: Bearer $(cat .admin-token.local)"

## ERP/CRM de la academia (10-jul-2026)
- **CRM (Interesados):** pipeline nuevo|contactado|prueba|alumno|perdido con nota, fecha de seguimiento
  (dot en el menu con los que tocan hoy) y boton WhatsApp con mensaje segun etapa. Alta manual + los que
  capta la web del tenant entran solos como "nuevo". Endpoint admin/lead (SOLO dueno).
- **Caja:** tabla `gastos` + pestana Caja (Cobros): P&L del mes = compras confirmadas - gastos. admin/gasto (SOLO dueno).
- **Comisiones:** profesores.comision_pct / tarifa_clase (boton Comision en Profesores, aplica tambien al dueno)
  + GET admin/liquidacion?mes=YYYY-MM: ingresos atribuidos, clases dictadas y a-pagar por profe.
- **Cupo por franja:** disponibilidad.cupo (0 = usa el cupo global de Ajustes). Doble clic en la celda
  del horario para asignarlo. Permite grupos y 1-a-1 conviviendo en la misma agenda.
- Schema: ALTERs perezosos via ensureErpSchema (corre solo en los endpoints nuevos; SELECTs con fallback).

## Facturacion electronica SUNAT via Nubefact (10-jul-2026)
- Por tenant, en Ajustes: ruta + token de su cuenta nubefact.com (modo demo gratis), serie B### (default B001),
  IGV gravado|exonerado (que lo decida su contador), "proximo numero" opcional si ya emitia fuera de Batuta.
- Emision: Pagos -> boton "Emitir boleta" en compras confirmadas (SOLO dueno; el rol profesor ni recibe la config).
- Robustez (review adversarial): numero RESERVADO con INSERT + UNIQUE(tenant,serie,numero) antes de llamar a
  Nubefact (sin carreras); si Nubefact rechaza limpio se libera el numero, si falla la red el numero queda
  reservado y el reintento de la MISMA compra lo reusa (Nubefact es idempotente por serie-numero); la respuesta
  se valida contra lo enviado; DNI obligatorio para boletas >= S/700 (regla SUNAT); ruta solo *.nubefact.com.
- OJO: "aceptada" refleja la respuesta de generacion; las boletas van a SUNAT por resumen diario (asincrono).
  Reconsulta automatica del estado = mejora futura si algun tenant la pide.
- Correo diario al dueno "N interesados por seguir hoy" en el cron de 9am (seguimientoLeadsDueno).
- La demo se siembra con pipeline CRM (5 etapas) + gastos + comision, y limpia comprobantes en su reset.

## Recibo universal (10-jul-2026) — para cualquier país
- Comprobante de pago con la marca de la academia (logo + color), NO fiscal, sirve en todo LatAm.
- Público en /app/r/<compra_id> (id = UUID inadivinable; la demo usa demo-cp-N). Solo compras confirmadas.
- En el panel (Pagos, columna Boleta): link "Recibo ↗" en cada pago confirmado (dueño). La boleta SUNAT/Nubefact sigue siendo el comprobante fiscal SOLO para Perú.
- Factura fiscal de otros países (México SAT, Colombia DIAN, etc.) = integración por país bajo demanda (Alegra cubre varios); NO construida hasta que un tenant de ese país la pida.

## Auto-responder de WhatsApp (10-jul-2026) — SCAFFOLD (necesita conexión de Meta)
- Webhook en /app/api/wa/webhook (GET verifica con WHATSAPP_VERIFY_TOKEN, POST recibe mensajes).
- Al llegar un mensaje: crea/actualiza el lead del tenant (etapa 'contactado', seguir hoy) y manda
  una auto-respuesta cálida de primer toque. NO es un bot multi-paso (el profe cierra desde su panel).
- Ruteo por tenant: config wa_phone_id = el phone_number_id del número de esa academia. Encendido con
  config wa_enabled='on' (apagado por defecto). Sin WHATSAPP_TOKEN el webhook es INERTE (200 vacío).
- QUÉ FALTA (paso de Andrés, no se puede probar sin esto): crear una app en Meta for Developers con
  WhatsApp Cloud API, conectar un número (WABA), y cargar los secrets:
    npx wrangler secret put WHATSAPP_TOKEN --name batuta-app   (token permanente de la WABA)
    npx wrangler secret put WHATSAPP_VERIFY_TOKEN --name batuta-app   (string que tú inventas)
  Luego en Meta: webhook URL https://batuta.lat/app/api/wa/webhook, verify token = el mismo, suscribir 'messages'.
  Y en cada academia: guardar su phone_number_id en config wa_phone_id + wa_enabled='on'.
- Verificado en prod: GET sin token = 403, POST inerte = 200. La lógica de lead+reply no se pudo
  probar E2E sin credenciales de Meta (misma situación que Nubefact hasta conectar la cuenta).

## Socio fundador (1 año gratis) — 10-jul-2026
- Activar a un profe/academia como fundador (default 12 meses, o {"meses":N}):
  curl -X POST https://batuta.lat/app/api/su/tenant -H "Authorization: Bearer $(cat .admin-token.local)" -H "content-type: application/json" -d '{"id":"<tenant_id>","accion":"fundador"}'
- Deja estado='trial' con trial_hasta a 1 año, salta el nurture (nurture_paso=9) y marca config fundador='on'.
- El <tenant_id> lo sacas de: curl -s https://batuta.lat/app/api/su/tenants -H "Authorization: Bearer $(cat .admin-token.local)"

## WhatsApp Cloud API — estado 11-jul-2026 (Fase A completa · Fase B: token permanente listo)
- App Meta "Batuta" id 2913551592328289 · WABA 1532220315245141 · numero de prueba +1 (555) 155-3825, phone_number_id 1149379364933769.
- **TOKEN PERMANENTE (Fase B) CARGADO**: System User "batuta-worker" (id 61591862819375, Admin) en el portfolio batuta.lat con acceso total a la app Batuta y a la WABA; token sin caducidad con permisos whatsapp_business_management + whatsapp_business_messaging. Cargado como secret WHATSAPP_TOKEN (via pbpaste | wrangler, nunca se imprimio). Si hay que rotarlo: Business Suite > Configuracion > Usuarios del sistema > batuta-worker > Generar token.
- WHATSAPP_VERIFY_TOKEN: copia en batuta-app/.wa-verify-token.local.
- **Diagnostico sin adivinar**: GET /app/api/su/wa-status (valida token contra Meta + lista numeros de la WABA + tenants con wa_phone_id) y POST /app/api/su/wa-test {phone_id,to,texto} (envio con respuesta cruda de Meta). Ambos con el ADMIN_TOKEN.
- **UI de tenant**: Ajustes > "WhatsApp de tu academia" (cfg_wa_enabled + cfg_wa_phone_id) en prod; la conexion del numero la hace Batuta (done-for-you) y se le pasa el phone_number_id al tenant.
- Webhook: https://batuta.lat/app/api/wa/webhook verificado; campo "messages" suscrito (fue el bug de Fase A: toggle a media tabla, revisar de nuevo al agregar numero real). E2E completo verificado con la demo, y envio con el token permanente verificado (wa-test a Andres, 200 + wamid).
- Demo conectada: config wa_phone_id + wa_enabled=on (se borra con el reset diario de la demo; re-setear para probar otro dia).
- **Fase B restante**: (1) numero REAL de produccion: conseguir un numero que reciba SMS/llamada (chip prepago sirve; NO puede estar en uso en la app de WhatsApp), agregarlo en Meta > WhatsApp > Configuracion de la API > Agregar numero, verificar por SMS, y anotar su phone_number_id; (2) conectar tenants reales (poner su phone_number_id en Ajustes); (3) verificacion del negocio en Business Manager: OPCIONAL por ahora (sin RUC/empresa es cuesta arriba; sin verificar hay tope de ~250 conversaciones iniciadas por el negocio/dia y limite de numeros, pero las RESPUESTAS a mensajes entrantes — el caso de Batuta — no lo necesitan).

## Importar alumnos por CSV (10-jul-2026) — EN PROD
- Onboarding: el tenant trae su lista de Excel de golpe. Personas -> Alumnos -> boton "Importar CSV" (junto a "+ Nuevo alumno").
- 100% CLIENT-SIDE, cero endpoints nuevos: parsea el CSV en el navegador y reusa el guardado existente (PUT /app/api/admin/data, que ya scopea por tenant/profesor server-side). Por eso NO agrega superficie de fuga entre tenants.
- Flujo: Descargar plantilla (Nombre,Curso,WhatsApp,Paquete,Notas,Profesor) -> subir CSV -> previsualizacion (cuenta + omitidos) -> Confirmar -> push a db.alumnos + apiPut.
- Robustez: detecta delimitador , o ; (Excel espanol); tolera comillas; mapea encabezados por alias con/sin acentos; si no hay encabezado usa el orden de la plantilla; obligatorio Nombre; omite duplicados (mismo nombre ya cargado) y filas sin nombre; limpia WhatsApp a digitos; defaults paquete="Paquete 4", pago="Pagado", fecha=hoy.
- Multi-profesor: columna Profesor se resuelve contra EQUIPO por nombre; los no reconocidos quedan del dueno (aviso en el preview). Para un profesor (no dueno) el server ya fuerza profesor_id=el mismo, la columna se ignora (sin fuga).
- Verificado E2E en prod contra la demo: 3 alumnos importados persistieron tras recargar (acentos/enie OK), delimitador ; OK, dedup OK. Codigo en public/panel/index.html: btnImportCsv, parseCsv, impMapHeader, impPreview, btnImpConfirmar.
- Export (ya existia): botones "CSV alumnos" / "CSV emails" en menu lateral -> Datos y respaldo (solo dueno).

## Guias de uso for-dummies (10-jul-2026)
- 4 guias por portal (alumno / profesor / academia / academia+) en el vault: proyectos/Batuta - Guia del portal del *.md
- Manual visual + 5 PDFs (4 por portal + completo) en ~/Desktop/Batuta-Guias/ (marca Batuta, tema claro, listos para WhatsApp). Fuente: Guias-Batuta.html.
- Dato de diseno de producto confirmado aqui: profesor/academia/academia+ son EL MISMO panel; solo cambian asientos (MAX_PROFES 1/5/20) y el gating solo-dueno (Profesores, Interesados, Caja).

## Ingreso manual facilitado + onboarding al dia (10-jul-2026, tarde)
- "Pega tu lista aqui" dentro del modal Importar CSV: un alumno por linea (de Excel/WhatsApp/nota), heuristica nombre/curso/celular/paquete, mismo preview+dedup+apiPut. Verificado E2E en prod (demo).
- Boton "Guardar y agregar otro" en el modal de alumno (solo al CREAR; oculto al editar): guarda y deja el formulario listo conservando curso/paquete/pago/fecha. Verificado E2E.
- Checklist de activacion: paso 2 ahora dice "Trae a tus alumnos (a mano, pegando tu lista o importando tu Excel/CSV)".
- Asistente IA (onboarding-ia, prompt admin): sabe explicar Importar CSV / pegar lista / guardar-y-otro. Correo dia-1 del nurture ("Mete a tus alumnos") menciona el importador.
- OJO cache: el navegador puede retener el HTML del panel (heuristica); tras deploy, probar con ?nc= o hard reload antes de diagnosticar "no salio".

## Paridad portada a profesormvt y nicole-web (10-jul-2026, tarde)
- Portado a AMBOS (sin tocar branding; mismos parches, script scratchpad/portar.py de la sesion): importador CSV + pegar lista + guardar-y-otro, chips "copiar link de cobro" en Inicio (usa el /pagar publico que ya existia), tour de bienvenida con anclas data-tour estables (personas/link-alumnos/cobros/#oiaFab, 1 vez por navegador via localStorage crm_tour_v1), recibo imprimible publico /r/<compra_id> (worker: reciboHTML + esc local + gate de assets deja pasar /r/* + run_worker_first), boton "Recibo ↗" en pagos confirmados, nombres de paquete UNIFICADOS en correos (los 2 inline viejos ahora usan NOMBRES_PAQUETE global "Plan Esencial/Intensivo/Estrella").
- profesormvt.com: DEPLOYADO (push main -> Action success) y verificado E2E en el CRM real (22 alumnos, 4 chips, 7 links de recibo, recibo real 200, tour auto-lanzado y cerrado SIN marcar visto para que Andres lo vea).
- nicole-web: codigo commiteado y pusheado; el DEPLOY del worker esta PENDIENTE (cuenta CF de Nicole 75cb4a4b..., token lo tiene Andres; wrangler de Andres da auth error 10000). Al tener el token: CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy desde ~/Code/nicole-web.

## Grupos portado a profesormvt y nicole-web (10-jul-2026, tarde-2)
- Unica feature del gap que Andres quiso (Caja/Reportes/cupo NO: son profesores particulares).
- Dos mitades portadas de Batuta a ambos: (a) "tambien estuvieron" en Registrar clase (N registros de una, cada alumno consume de SU paquete); (b) pestana Grupos (nav Alumnos) con CRUD + boton "Registrar clase" del grupo que pre-marca miembros. Adaptado single-teacher: cursos de MARCA.cursos, endpoint /api/admin/grupo sin tenant/profesor, tabla grupos sin tenant_id creada via ensureSchema (auto-migra al primer hit).
- profesormvt.com: DEPLOYADO y verificado E2E con data real (grupo creado con 2 miembros -> persistio -> registrar clase pre-marco -> borrado limpio; NO se registro ninguna clase real).
- nicole-web: commiteado/pusheado; deploy sigue esperando el token CF de Nicole (mismo pendiente de la tanda anterior).
- OJO curl vs edge: tras deploy el primer curl puede traer HTML viejo de un hop intermedio; probar con ?v=<ts> antes de diagnosticar.

## Nicole: deploy completado (10-jul-2026, tarde-3)
- Token CF nuevo creado por Andres (custom: Workers Scripts/D1/R2/Workers AI Edit sobre la cuenta de Nicole), guardado en ~/Code/nicole-web/.cf-api-token.local (gitignored).
- Deploy: cd ~/Code/nicole-web && CLOUDFLARE_API_TOKEN="$(cat .cf-api-token.local)" npx wrangler deploy
- Verificado E2E en su CRM real (sesion de Andres): pegar lista persiste, grupo con miembros persiste, pre-marcado del registro grupal OK, /r/ OK. Data de prueba borrada (cuenta quedo en 0).
- Lecciones del E2E: (1) el estado optimista del panel puede enganar — verificar SIEMPRE con recarga dura tras guardar; (2) al automatizar el modal de grupo, esperar a que abrirGrupo() pinte los checkboxes antes de marcarlos (la primera corrida guardo miembros=[] por esa carrera del test, no del codigo).
- El CRM de Nicole vive en nicole-crm-worker.nicoleolavarria.workers.dev/admin/crm/ (el dominio .com es solo el sitio Vercel).

## Fix: el tour esperaba al login (10-jul-2026, tarde-4)
- Bug reportado por Andres: en MVT/Nicole el tour salia SOBRE el candado (el lock es overlay en la misma pagina, no pagina aparte como Batuta; la condicion vieja db.alumnos&&linksCobro pasaba siempre porque db arranca con defaults).
- Fix en ambos paneles: el auto-lanzado exige window.__crmData (solo se pone true dentro del .then del GET autenticado; el 401 va al catch->lock) + candado #ovLock cerrado. Sin login es imposible por construccion.
- Clave localStorage v1 -> crm_tour_v2: quienes lo vieron sobre el candado lo ven de nuevo, ya adentro.
- Deployado a ambos (MVT via Action, Nicole via wrangler+token local). Verificado E2E el caso con sesion; el caso sin sesion quedo verificado estaticamente (la simulacion dinamica desde una pestana CON sesion es imposible sin tocar el token, y el primer intento dio falso negativo por carrera del test).

## Reprogramacion configurable por el profesor (10-jul-2026, tarde-5) — LOS 3 SISTEMAS
- Pedido de Andres: que el profesor decida (1) si el alumno puede reprogramar solo y (2) con cuantas horas de anticipacion.
- Config por profesor (Batuta: por tenant): reprog_activo ('' = ON default | '0' = OFF) + reprog_min_h (1-72; vacio = 4). Helper reprogCfg() junto a CANCELA_MIN_H en los 3 workers.
- Worker: agenda/cancelar responde 403 con mensaje claro si esta apagado, y usa las horas configuradas; /api/me (o /app/api/me) expone reprog:{activo,min_h} al portal.
- Portal alumno: AG_REPROG_ON + AG_CANCELA_MIN_H dinamicos via agSyncReprog() (lee de ME); boton Reprogramar se OCULTA si esta apagado; textos de horas dinamicos.
- Panel Ajustes: seccion "Reprogramaciones del alumno" (select si/no + horas) en los 3; whitelist de config ampliada; Batuta ademas sanitiza server-side (activo solo ''|'0', horas 1-72).
- Deployado a los 3 (batuta wrangler, MVT Action, Nicole wrangler+token). Verificado E2E en la demo Batuta: guardar '0'/8 persiste, 999 se sanea a vacio, reponer defaults OK; HTML vivo verificado en los 6 frentes (panel+portal x3).
- El manual PDF de Nicole se actualizo con la regla configurable (seccion 07).

## Pasarelas de pago del profe: Stripe + Culqi + Yape-auto por MP (12-jul-2026) — DEPLOYADO, gated OFF
Se agregaron 2 rieles nuevos de cobro alumno->profe, espejando el marketplace de MP. Ambos DEGRADAN CON GRACIA: sin sus secrets, el boton/tarjeta no aparece y los endpoints dan 501. Deployado (version con los 3 rieles); Stripe y Culqi quedan INERTES hasta cargar secrets. Yape-auto es solo un relabel del checkout de MP.

- **Yape-auto por MP:** el metodo "Tarjeta (Mercado Pago)" del portal/publico se re-etiqueto a "Tarjeta o Yape (se confirma solo)". El checkout de MP ya ofrece Yape si la cuenta MP del profe lo tiene; se confirma por el webhook que ya existe. Cero secrets nuevos. (Ojo: si el profe no tiene Yape en su MP, solo veran tarjeta; no promete de mas porque MP decide que metodos muestra.)

- **STRIPE CONNECT (riel internacional; Stripe NO opera en Peru):** Standard connected account + Connect Onboarding (Account Links) + direct charges (header Stripe-Account) + application_fee omitido (0 comision). Guarda solo stripe_account_id/charges_enabled, NO tokens.
  - Encender: `npx wrangler secret put STRIPE_SECRET_KEY --name batuta-app` (sk_live_ de la cuenta de PLATAFORMA Stripe de Andres, entidad no-peruana/UE) + `npx wrangler secret put STRIPE_WEBHOOK_SECRET --name batuta-app` (whsec_ del endpoint de webhook).
  - En el Dashboard de Stripe: registrar un webhook Connect apuntando a `https://batuta.lat/app/api/stripe/webhook`, evento `checkout.session.completed`, "Listen to events on Connected accounts". Copiar el whsec_ al secret.
  - Endpoints: /app/api/admin/stripe/{estado,conectar,desconectar}, /app/api/stripe/crear-alumno, /app/api/stripe/webhook. Panel: tarjeta "Pago internacional (Stripe)" con selector de moneda (config `stripe_moneda`, default usd). El profe cobra en SU moneda; monedas sin decimales (CLP...) se manejan con stripeMinorUnit(). Firma del webhook: HMAC-SHA256 manual sobre el body crudo (sin SDK). BLOQUEANTE real: cuenta de plataforma Stripe verificada (KYC de Andres).

- **CULQI (BYOK; tarjeta+Yape por API, para Peru con RUC) — ✅ ENCENDIDO 13-jul-2026:** el profe pega pk_live_/sk_live_ en Ajustes; la sk_ se cifra AES-GCM en reposo y NUNCA se expone al front. Cargo sincrono POST /v2/charges + webhook de respaldo que RE-VERIFICA el cargo con la sk_. Requiere RUC del profe.
  - CULQI_ENC_KEY ya cargado como secret en el worker (13-jul). Backup del valor en el vault: `secreto/credenciales/batuta-culqi-enc-key.txt` (perm 600, fuera de git/Obsidian). Si se pierde ese valor Y se borra el secret, las sk_ cifradas quedan ilegibles y los profes deben reconectar.
  - (Cómo se generó: `openssl rand -hex 32` → `wrangler secret put CULQI_ENC_KEY`.)
  - Endpoints: /app/api/admin/culqi/{estado,conectar,desconectar}, /app/api/culqi/crear-cargo, /app/api/culqi/webhook-alumno?t=<tenant>. Panel: tarjeta "Tarjeta y Yape por API (Culqi)". Portal alumno: widget Culqi Checkout v4 (carga js de checkout.culqi.com al primer uso; CSP de Batuta lo permite). El webhook de Culqi el profe lo pega A MANO en su CulqiPanel > Eventos (no hay API); la via sincrona ya confirma, el webhook es cinturon-y-tirantes.
  - Manejo de fallo AMBIGUO (timeout/red): NO se borra la compra; queda 'pendiente' para reconciliar (evita "alumno cobrado sin paquete").

- **Revision adversarial (12-jul):** 9 hallazgos, 5 arreglados pre/post-deploy (1 critico: Stripe cobraba 100x en monedas sin decimales; 2 altos de Culqi: respuesta ambigua borraba la compra; webhook Culqi ahora re-verifica; credito de referido en soles no aplica a Stripe; ping de sk_ exige 2xx). Verificado en vivo: panel + /pagar cargan sin errores de consola, tarjetas Stripe/Culqi ocultas mientras el gate esta off, endpoints dan 401 no 500.
- PENDIENTE de Andres para activar: cargar los secrets de arriba + (Stripe) tener cuenta de plataforma verificada + (Culqi) que el profe tenga afiliacion con RUC.

## Soporte con IA + modulos apagables (14-jul-2026) — DEPLOYADO y verificado E2E
- **El widget "?" dejo de ser "Guia del panel" y ahora es SOPORTE** (panel: "Soporte"; portal alumno: "Ayuda").
  Mismo endpoint /app/api/onboarding-ia, evolucionado en sitio:
  - Cuota MENSUAL (antes vitalicia) y POR PERSONA: clave admin:<profesor_id>:YYYY-MM (cada profe/dueno su bolsa de 60; la demo comparte al dueno demo a proposito) y alumno:<cuenta_id>:YYYY-MM (15) + TECHO de 150/mes por tenant para alumnos (el registro de alumnos es abierto; sin techo, cuentas frescas = bolsas frescas). Contador con upsert atomico (WHERE mensajes < limite). El front lee d.limite (adios "/10" hardcodeado).
  - Cerebro nuevo: system prompt con TODO el producto (planes S/49/149/299 + por-alumno, servicios S/350/200/180/129, multi-profesor, CRM, caja, Nubefact, recibo universal, importador, modulos). Fuente: las 4 guias del vault con precios corregidos. Con cache_control (prompt caching) en la llamada a Anthropic; max_tokens 350. Estilo: texto plano sin markdown. Ademas un 2do bloque system SIN cache con el contexto de SESION: si el actor es PROFESOR (no dueno) se le dice que no ve las pestanas de dueno, y si el tenant oculto modulos se le avisa (asi el bot no manda a pestanas que el usuario no tiene). Los precios el bot los repite SIEMPRE del manual, nunca del historial (que viene del cliente y puede venir forjado).
  - Escape a humano: link "Hablar con una persona (WhatsApp)" al pie del widget del panel (wa.me/51989077928 con el slug). El alumno se deriva al chat con su profe.
  - Log de conversaciones: tabla soporte_ia_log con quien (dueno|profesor|alumno) e historial DEL CLIENTE incluido (sin el, una respuesta dirigida por historial forjado pareceria alucinacion al triarla). Lazy CREATE + ALTER idempotente; tambien en schema.sql. Ver que preguntan: curl -s "https://batuta.lat/app/api/su/soporte-log?limit=100" -H "Authorization: Bearer $(cat .admin-token.local)".
- **Modulos apagables por tenant** (Ajustes > "Modulos de tu panel"): config modulos_off (csv, whitelist server-side: grupos|material|leads|caja|reportes). El panel oculta tabs/grupos con .mod-off (mismo gesto que solo-dueno) en aplicarModulos() desde renderAll(); si el tab activo queda oculto vuelve a Inicio. NO es control de acceso (los endpoints siguen vivos); es UX. **Chat NO es apagable** (el portal del alumno lo sigue ofreciendo; ocultarlo solo en el panel dejaba mensajes huerfanos) y Agenda tampoco, a proposito. Portal del alumno: pendiente (ver PENDIENTES.md).
- Review adversarial post-deploy: 9 hallazgos confirmados (3 lentes x verificacion), los 9 arreglados el mismo dia (cuota por persona, upsert atomico, techo por tenant de alumnos, chat no apagable, prompt del alumno sin recibo inventado, contexto de sesion, historial en el log, 429 por rol).
- Verificado en vivo en la demo (2 rondas): bot responde precios vivos (recomendo Academia para 3 profes) y la realidad del recibo, contador por persona, flags ocultan Grupos + grupo Material entero y persisten tras recarga dura, historial cae al log, demo restaurada, 0 errores de consola.

## Plan "Academia por alumno" (cobro del SaaS por alumno activo) — 12-jul-2026, DEPLOYADO
La "palanca del millon" del deck: la academia paga el SaaS segun sus alumnos ACTIVOS, no un plan fijo. Es OPT-IN (un cuarto plan) y gated por MP_ACCESS_TOKEN (que ya esta en prod). Los 3 planes fijos NO cambian.
- **Formula:** cobro mensual = max(MIN_ALUMNOS_FACTURABLES=5, alumnos activos) × PRECIO_ALUMNO_PEN=5 (PEN). Display US$1.50/alumno (TC ~3.40). Para ajustar el precio: cambiar `PRECIO_ALUMNO_PEN` y `PRECIO_ALUMNO_USD` en worker/index.js (son numeros de negocio; Andres los define/confirma antes de venderlo).
- **Alumno activo:** `contarAlumnosActivos()` = alumnos con vence >= hoy-35d, o sin vence (alta manual). Piso de 5 para evitar cobros infimos.
- **Cobro:** MP `/preapproval` DIRECTO de monto dinamico (no plan fijo pre-creado) via la rama por_alumno de /app/api/t/suscribir; guarda mp_preapproval_id de una. cambiar-plan hacia/desde por_alumno usa el monto dinamico. vincular-sub acepta el preapproval directo por external_reference==tenant.id.
- **Recalculo:** cron diario `recalcularPorAlumno()` (14:00 UTC): por cada academia por_alumno con suscripcion authorized/active, recomputa activos y hace PUT al preapproval SOLO si el monto cambio (rige desde el proximo cobro).
- **UI:** Perfil > Tu plan muestra el boton "Academia por alumno" + estimado en vivo ("con tus N activos, tu cobro seria S/X/mes"). /app/api/t/me expone alumnos_activos + por_alumno_monto_pen. Verificado en la demo (5 activos -> S/25/mes, sin errores de consola).
- **CAVEAT no testeable sin credenciales:** el /preapproval directo puede toparse con el error "payer must be real user" o no respetar free_trial en MP (por eso los planes fijos usan planes pre-creados). Si MP lo rechaza, el profe recibe 502 y va a WhatsApp (degradado, no rompe). Validar con un cobro real cuando haya una academia grande de verdad. MAX_PROFES.por_alumno = 50.
- **Revisión adversarial (12-jul, 7 hallazgos, arreglados):** guard anti-doble-cobro en /suscribir (bloquea si ya hay sub authorized; cancela el preapproval previo antes de crear otro, para no dejar huérfanos cobrando); cambiar-plan HACIA por_alumno con sub previa = cancela y crea preapproval directo nuevo (devuelve init_point, el panel redirige); recálculo cachea el último monto en `mp_monto_alumno` (no más PUT diario perpetuo) y ALERTA a Andrés (alertaCorreoAndres) + re-chequea status cuando hay un salto grande de cobro (MP puede pausar la sub); alumno activo ahora EXIGE vence (no se factura alta manual sin paquete). El free_trial sin verificar queda como el caveat de arriba.
