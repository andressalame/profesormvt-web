-- v18 (2026-06-23): biblioteca privada de ejercicios (banco para mandar de tarea)
CREATE TABLE IF NOT EXISTS ejercicios (
  id          TEXT PRIMARY KEY,
  titulo      TEXT DEFAULT '',
  descripcion TEXT DEFAULT '',
  url         TEXT DEFAULT '',
  curso       TEXT DEFAULT 'Todos',
  fecha       TEXT DEFAULT ''
);
