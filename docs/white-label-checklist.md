# Checklist: desplegar el sistema a un cliente nuevo (white-label)

Guía paso a paso para clonar este CRM (hoy en producción como profesormvt.com) y
levantarlo para otro profesor/academia de música. Sigue el orden: cada paso
depende del anterior.

## 1. Clonar el repo

```
git clone <este-repo> nombre-del-cliente
cd nombre-del-cliente
npm install
```

## 2. Editar los 3 bloques MARCA (worker + 2 paneles)

Son la ÚNICA fuente de datos del negocio. Todo lo demás en el código es genérico.

- **`worker/index.js`** — bloque `const MARCA = {...}` cerca del tope del archivo (junto a
  `PAQUETES`). Campos: `nombre`, `profe`, `dominio`, `correoAvisos`, `correoAdmin`,
  `whatsapp`, `ciudad`, `statementDescriptor`, `vapidSubject`, `leadMagnetPdf`.
- **`public/admin/crm/index.html`** — bloque `var MARCA = {...}` (buscar
  "white-label" en el archivo). Campos: `nombre`, `inicial`, `profe`, `cursos`,
  `cursoDefault`, `portalUrl`, `archivoExport`.
- **`public/alumnos/index.html`** — bloque `var MARCA = {...}`. Campos: `nombre`,
  `logoHtml`, `profe`, `whatsapp`, `cursos`, `referidoSoles`, `rubro`.

**Valores que deben calzar EXACTOS entre los 3 bloques** (si no, el sistema queda
inconsistente sin avisar):

| Worker | Panel admin / portal alumno | Significado |
|---|---|---|
| `MARCA.dominio` | `portalUrl` (admin) | mismo dominio, sin trailing slash extra |
| `MARCA.whatsapp` | `whatsapp` (alumnos) | mismo número, formato `51989077928` (sin +, sin espacios) |
| `MARCA.nombre` | `nombre` (ambos paneles) | mismo nombre de marca |
| `MARCA.profe` | `profe` (ambos paneles) | mismo nombre del profesor |
| `CREDITO_REFERIDO` (worker, ~línea 53) | `referidoSoles` (alumnos) | mismo S/ de premio por referido |
| `CANCELA_MIN_H` (worker, ~línea 1074) | `AG_CANCELA_MIN_H` (alumnos) | mismas horas mínimas para reprogramar sin perder la clase |

Si el cliente da otros cursos (no canto/piano/composición), también ajusta
`PAQUETES`/`PRECIOS_DEFAULT` en el worker y `PAQUETES`/`PRECIOS_DEFAULT` +
`cursos` en ambos paneles.

## 3. `wrangler.toml`

- `name` — nombre único del Worker (ej. `nombre-cliente-web`).
- Ruta/dominio del sitio (custom domain o `routes`, según cómo esté configurado el
  proyecto en Cloudflare).
- `[[d1_databases]]` — `database_name` y `database_id` NUEVOS (crear con
  `wrangler d1 create nombre-cliente-crm` y pegar el id que devuelve).
- `[[r2_buckets]]` — `bucket_name` NUEVO (crear con `wrangler r2 bucket create
  nombre-cliente-recursos`) y actualizar el binding `RECURSOS_R2`.
- `send_email` (binding `AVISOS`) — requiere el dominio de correo del cliente
  verificado en Cloudflare Email Routing.
- `[vars] VAPID_PUBLIC_KEY` — generar un par de claves VAPID nuevo para el
  cliente (no reusar el de otro despliegue; ver paso 5).

## 4. Base de datos: crear D1 y aplicar el schema

```
wrangler d1 create nombre-cliente-crm
# pegar el database_id en wrangler.toml
wrangler d1 execute nombre-cliente-crm --remote --file=db/schema.sql
```

`db/schema.sql` es el schema base. Los `db/schema-vN.sql` son migraciones
incrementales aplicadas en producción a lo largo del tiempo — en un despliegue
NUEVO probablemente ya no hace falta correrlas todas a mano: revisa si
`schema.sql` ya las incluye. Si no, aplícalas en orden (`schema-v2.sql`,
`schema-v3.sql`, ...) hasta la última.

Para lo aditivo (columnas/tablas nuevas que el propio worker crea si no
existen, ej. `chatbot_uso`, `onboarding_ia_uso`), el worker tiene
`ensureSchema` (o equivalente) que corre al vuelo — no hace falta migración
manual para eso, basta con desplegar y dejar que la primera request lo cree.

## 5. Secretos (`wrangler secret put <nombre>`)

| Secreto | Para qué |
|---|---|
| `ADMIN_TOKEN` | login del panel admin (generar uno random largo, no reusar el de otro cliente) |
| `MP_ACCESS_TOKEN` | Mercado Pago del cliente (cobro con tarjeta) |
| `RESEND_API_KEY` | envío de correos transaccionales (Resend, plan gratis alcanza) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push (generar par nuevo, ej. con `npx web-push generate-vapid-keys`; el público también va en `[vars]` de wrangler.toml) |
| `ANTHROPIC_API_KEY` | opcional — solo si el cliente quiere el asistente de onboarding con Claude Haiku (si no se define, ese endpoint degrada solo, sin romper nada) |

## 6. Assets de marca

En `public/` (o donde estén hoy logo/favicon/og-image de este repo):

- `logo*` (horizontal, ícono) y `favicon.svg`/`favicon-preview.png`
- `og-image.jpg` (preview al compartir el link)
- `punk-bg.svg` (o el fondo/textura equivalente del diseño actual)
- Color de marca: variable CSS `--accent` (buscar en el CSS de ambos paneles y
  del sitio público) + `theme-color` en el `<meta>` de cada HTML

Sigue la regla de "marca antes de diseñar": no inventar estética nueva, partir
de los assets reales que entregue el cliente.

## 7. Google OAuth (Google Calendar)

- Crear un proyecto OAuth propio del cliente en Google Cloud Console (client id
  + client secret).
- Redirect URI = `MARCA.dominio + "/api/google/oauth/callback"` (calza con la
  constante `GCAL_REDIRECT` del worker, que ya se arma sola desde `MARCA.dominio`).
- Las credenciales NO van en wrangler.toml ni en secrets fijos: se cargan desde
  el CRM → Ajustes (quedan en la tabla `config` de D1), junto con la conexión
  (botón "Conectar Google Calendar").

## 8. Mercado Pago del cliente

- Access token del cliente (cuenta de Mercado Pago propia, no la de otro
  negocio) → secreto `MP_ACCESS_TOKEN`.
- El webhook de confirmación de pago apunta solo a
  `MARCA.dominio + "/api/mp/webhook"` — se arma solo desde el bloque MARCA, no
  hay que configurarlo a mano en el worker, pero SÍ hay que verificar en el
  panel de Mercado Pago del cliente que las notificaciones IPN/webhook apunten
  a esa URL.
- `statement_descriptor` (extracto de tarjeta) = `MARCA.statementDescriptor`,
  máximo 22 caracteres.

## 9. Resend

- Verificar el dominio de correo del cliente en Resend (registros SPF/DKIM en
  su DNS).
- `MARCA.correoAvisos` debe ser una dirección de ese dominio verificado (ej.
  `avisos@dominio-cliente.com`).

## 10. Deploy y smoke test

Deploy vía GitHub Action (si el repo la trae configurada, empuja a la rama que
dispara el deploy) o manual:

```
npx wrangler deploy
```

Smoke test después de deployar:

1. `curl https://dominio-cliente.com/api/publico` — debe responder 200 con
   `{google_client_id: ...}` (o vacío si aún no se configuró Google).
2. Registrar una cuenta de prueba desde `/alumnos/` (registro nuevo, sin pagar
   todavía) y confirmar que llega el correo/push esperado.
3. Hacer una compra de prueba (Clase de prueba, S/ el precio configurado) y
   confirmarla manualmente desde el CRM admin → verificar que el alumno se
   crea, el correo de bienvenida sale con la marca correcta (nombre/profe/
   dominio/WhatsApp del cliente, no los de ProfesorMVT), y el crédito de
   referido (si aplica) se acredita bien.
4. Revisar que ningún correo/notificación mencione "ProfesorMVT",
   "profesormvt.com", el WhatsApp o el correo de Andrés — si aparece algo así,
   quedó una referencia hardcodeada fuera del bloque MARCA (no debería pasar,
   pero es la señal de que algo se filtró).

## Notas

- El worker es un solo archivo (`worker/index.js`) con routing por cadena de
  `if`, sin dependencias nuevas ni TypeScript — mantén ese estilo si tocas algo
  más allá de MARCA.
- Los archivos `.sql` de `db/` y los comentarios del código no necesitan
  tocarse para un despliegue nuevo (no traen datos ni marca de ProfesorMVT).
- Todo el copy en español debe mantenerse en registro peruano de clase alta,
  limpio y directo, sin autodesprecio ni menospreciar al alumno ni al profesor
  (ver reglas de tono en la memoria del proyecto si vas a escribir copy nuevo
  para el cliente).
