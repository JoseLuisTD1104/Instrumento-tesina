// Configuración pública de Supabase para el panel de "corto".
// Solo URL del proyecto y clave PUBLICABLE (sb_publishable_...). Nunca la clave secreta.
// La clave publicable se ve en el navegador por diseño: lo que protege los datos es RLS en Supabase.
window.CORTO_CONFIG = Object.freeze({
  SUPABASE_URL: "<PEGA_AQUI_LA_URL>",
  SUPABASE_PUBLISHABLE_KEY: "<PEGA_AQUI_LA_CLAVE_PUBLICABLE>",
});
