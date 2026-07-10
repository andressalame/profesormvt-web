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
