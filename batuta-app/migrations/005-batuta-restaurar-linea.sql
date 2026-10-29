-- 005 (REVERSION): devolver la linea 1353785221144478 a Batuta. Requiere antes migrations/004 (suelta la linea de webexpress).
UPDATE wa_negocio SET enabled = 'on', phone_id = '1353785221144478', actualizado = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE id = 'batuta-3402' AND phone_id = 'batuta-sin-linea';
