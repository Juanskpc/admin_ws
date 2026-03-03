/**
 * Almacén en memoria de códigos de acceso de un solo uso.
 * Cada código expira en 30 segundos y solo puede canjearse una vez.
 */

const store = new Map(); // code → { idUsuario, token, expiresAt }

// Limpieza automática cada 60 segundos para evitar leaks de memoria
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(code);
  }
}, 60_000);

function save(code, data) {
  store.set(code, { ...data, expiresAt: Date.now() + 30_000 });
}

/** Obtiene y ELIMINA el código (one-time use). Retorna null si inválido/expirado. */
function consume(code) {
  const entry = store.get(code);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(code);
    return null;
  }
  store.delete(code);
  return entry;
}

module.exports = { save, consume };
