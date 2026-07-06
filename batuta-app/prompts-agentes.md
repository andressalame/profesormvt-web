# Prompts exactos para los 2 subagentes (corrida nocturna)

## AGENTE A — Backend multi-tenant (sonnet, effort high, background)

Implementa el BACKEND multi-tenant de Batuta App. Lee PRIMERO y sigue al pie de la letra el contrato: /Users/andres/Code/mvt/web/batuta-app/SPEC.md

Tus archivos (NO toques nada fuera de batuta-app/):
- /Users/andres/Code/mvt/web/batuta-app/worker/index.js — copia EXACTA del core de MVT (2900+ líneas). La transformas según el SPEC.
- /Users/andres/Code/mvt/web/batuta-app/db/schema.sql — lo creas desde cero (schema limpio consolidado CON tenant_id; puedes leer los /Users/andres/Code/mvt/web/db/schema*.sql y el ensureSchema del worker como referencia de las tablas/columnas que el código realmente usa).
- /Users/andres/Code/mvt/web/batuta-app/wrangler.toml — lo creas según el SPEC (mira /Users/andres/Code/mvt/web/wrangler.toml para replicar el patrón de assets del core; deja database_id = "PENDIENTE").
- /Users/andres/Code/mvt/web/batuta-app/PENDIENTES.md — anota ahí todo lo que apagaste o dejaste para v1.

MÉTODO OBLIGATORIO (el archivo es grande, hazlo por fases y verifica cada una):
1. Lee el SPEC completo y el worker copia entero (en chunks) haciendo un inventario de: todas las tablas usadas, todos los endpoints, todas las queries (busca env.DB.prepare) y todos los usos de bindings/secretos (env.*).
2. Escribe db/schema.sql limpio con tenant_id integrado y los UNIQUEs del SPEC. Incluye tenants y sesiones.
3. Transforma el worker en este orden: (a) rutas → prefijo /app y /app/api; (b) tabla tenants + registro/login/logout/me de profesor + tenantDeSesion (sesiones con cuenta_id 'T:'+id, patrón __ADMIN__ que ya existe en el core); (c) REEMPLAZA la auth del árbol admin (era ADMIN_TOKEN/esAdminAuth) por sesión de tenant, y agrega superadmin /app/api/su/* con env.ADMIN_TOKEN; (d) scoping: TODAS las queries con tenant_id (las del árbol admin usan el tenant de la sesión; las de alumno resuelven tenant vía cuentas.tenant_id de la sesión, y las pre-login vía slug); (e) trial gate middleware 402; (f) guards de integraciones apagadas (R2 sin binding, MP 501, sin Resend/VAPID/AI) y scheduled() vacío; (g) ensureSchema del core: elimínalo o redúcelo (la DB nace completa del schema.sql; deja solo un guard barato).
4. Después de CADA fase: node --check batuta-app/worker/index.js.
5. Auditoría final de fuga entre tenants: grep de TODOS los env.DB.prepare y verifica uno por uno que llevan tenant_id en el WHERE o vienen de una resolución por sesión/slug; lista en tu reporte cualquier query global que dejaste a propósito (ej. sesiones por token, tenants por email, rate limit por IP) y por qué es segura.
6. Prueba local real: cd batuta-app && npx wrangler d1 execute batuta-app --local --file db/schema.sql && npx wrangler dev --local --port 8791 en background, y con curl prueba: POST /app/api/t/registro (crea tenant) → t/me con el token → crear un alumno vía el API admin → registrar una segunda cuenta tenant y verificar que NO ve los alumnos del primero → GET /app/api/publico?slug=... Da de baja el dev server al final. Si wrangler dev no corre en esta máquina (macOS viejo, el runtime puede fallar), anótalo y compensa con la auditoría de queries + node --check.

Las páginas /app/registro y /app/login sírvelas INLINE desde el worker (HTML mínimo estilo Batuta: fondo #0F1115, ámbar #E8A13D, fuentes Bricolage Grotesque + Space Grotesk de Google Fonts; registro: academia, tu nombre, email, WhatsApp, contraseña ×2, copy "7 días gratis, sin tarjeta"; login: email+pass; al éxito guardan el token en localStorage 'batuta_t' y van a /app/panel). Los paneles HTML los adapta otro agente EN PARALELO; no los toques, pero tu worker debe servirlos como dice el SPEC.

Mensaje final: inventario de endpoints resultante, lista de queries globales justificadas, qué apagaste (PENDIENTES.md), resultado de node --check y de la prueba local (o por qué no corrió). Sin florituras.

## AGENTE B — Paneles (sonnet, effort high, background)

Adapta los PANELES de Batuta App. Lee PRIMERO y sigue al pie de la letra el contrato: /Users/andres/Code/mvt/web/batuta-app/SPEC.md (secciones "Paneles" y "Decisiones de arquitectura" sobre rutas y sesión).

Tus archivos (NO toques nada fuera de estos dos; el worker y las páginas de registro/login las hace otro agente EN PARALELO):
- /Users/andres/Code/mvt/web/batuta-app/public/panel/index.html — copia del CRM de MVT (2200+ líneas). Es el panel del PROFESOR tenant.
- /Users/andres/Code/mvt/web/batuta-app/public/alumnos/index.html — copia del portal de alumnos de MVT (1800+ líneas).

TRANSFORMACIONES DEL PANEL (panel/index.html):
1. API base: todos los fetch de '/api/...' pasan a '/app/api/...'. El árbol admin ('/api/admin/...') pasa a '/app/api/admin/...'.
2. Auth: el candado de clave (modal "Acceso de admin" + TOKEN_KEY 'pmvt_admin_token' + /api/admin/login) se reemplaza por: token en localStorage 'batuta_t'; si falta o cualquier request da 401 → window.location = '/app/login'. Elimina el modal del candado.
3. Trial: al cargar, GET /app/api/t/me → pinta banner fijo arriba "Prueba gratis: te quedan X días · Activar mi plan" (X = dias_trial_restantes; si estado='activo' no hay banner). Si CUALQUIER request devuelve 402 → overlay paywall a pantalla completa: "Tu semana de prueba terminó", los 3 planes (Profe S/49/mes · Academia S/149/mes · Academia XL S/249/mes) y botón "Activar por WhatsApp" → https://wa.me/51989077928?text= URL-encoded 'Hola Andrés, quiero activar mi plan de Batuta (academia: '+slug+')'. El overlay no se puede cerrar.
4. Branding Batuta estándar: reemplaza el acento #e8501f por #E8A13D en TODO el CSS/SVG/meta theme-color; quita 'ProfesorMVT'/'MVT'/'punk' de títulos y textos (title = 'Batuta · Panel'); el sidebar lleva wordmark 'BATUTA' arriba y debajo el nombre de la academia (de t/me); el bloque MARCA JS se adapta: nombre 'Batuta', cursos default ['Canto','Piano','Guitarra'], portalUrl y archivoExport dinámicos del slug.
5. "Comparte con tus alumnos": en Resumen, tarjeta con el link location.origin + '/app/a/' + slug y botón Copiar.
6. Ajustes: secciones de Google Calendar y Google Sign-In deshabilitadas con nota "Se conecta al activar tu plan" (inputs disabled); Yape/Plin/titular/bancos/crypto y precios operativos. Nada de "npx wrangler" visible.
7. La IA de onboarding (widget "?") apagada: oculta el botón. 8. Push del admin: oculta la sección.

TRANSFORMACIONES DEL PORTAL DE ALUMNO (alumnos/index.html):
1. API base '/app/api/...'. El slug sale de location.pathname (/app/a/<slug>); var SLUG; mándalo en registro, login y publico (?slug=). Con sesión, el resto no necesita slug.
2. Branding Batuta: acento #E8A13D, title 'Portal de alumno · Batuta', el eyebrow/logo muestran el nombre de la ACADEMIA (de /app/api/publico) con un 'con Batuta' pequeño en el footer del sidebar. Bloque MARCA adaptado (whatsapp del profesor viene de la config del tenant vía publico/me; si no hay, oculta los links de WhatsApp).
3. Tarjeta OCULTA en v0 (solo Yape/Plin/transferencias/crypto según config del tenant). Push oculto. Google Sign-In oculto. 'Olvidé mi contraseña' → texto 'Escríbele a tu profesor para restablecerla'.
4. Verifica que nada de MVT quedó hardcodeado (S/50, Estrella, referidos): todo del API o oculto.

REGLAS: mismo estilo del código (var, esc(), español), cero em dash, signos ! ? solo al cierre. Copys de usuario final.

VERIFICACIÓN OBLIGATORIA: node --check de los <script> extraídos; grep final: cero '/api/' sin prefijo /app en fetch, cero '#e8501f', cero 'profesormvt' (case-insensitive), cero 'pmvt_admin_token'. Sin IDs duplicados nuevos.

Mensaje final: lista de cambios por archivo + verificaciones + qué ocultaste. Sin florituras.
