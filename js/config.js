// Datos públicos de conexión. La clave publicable está hecha para ir en el
// navegador: lo que protege los datos es RLS (sql/02_cobro.sql).
// La service role key NUNCA va acá.
window.MEK_CONFIG = {
  supabaseUrl: 'https://qemrmkwpsdiacaicedny.supabase.co',
  supabaseKey: 'sb_publishable_Ty8mQVambEq5yubkcTMTOw_GjTlWoQM',
  // Dashboard de turnos y fichas. Solo se LEE, con GET. Ver js/pacientes.js.
  firebaseDb: 'https://mek-dashboard-default-rtdb.firebaseio.com',
  firebasePacientes: 'mek/p',
  // Lectura de facturas con IA (supabase/functions/leer-factura). Tiene
  // costo por uso: apagada. Para activarla, ver su LEEME y poner true.
  iaFacturas: false,
};
