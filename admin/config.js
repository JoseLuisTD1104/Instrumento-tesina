// Configuración pública de Supabase para el panel de "corto".
// Solo URL del proyecto y clave PUBLICABLE (sb_publishable_...). Nunca la clave secreta.
// La clave publicable se ve en el navegador por diseño: lo que protege los datos es RLS en Supabase.
window.CORTO_CONFIG = Object.freeze({
  SUPABASE_URL: "https://dbvzgdcfzdmetscgsrpv.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_YVaF5ky8wHFHobir542nIg_4OC7iIm0",
});
