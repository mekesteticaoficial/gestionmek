// Pacientes: la identidad la manda el dashboard (Firebase, mek/p).
//
// REGLA 1: esta app nunca escribe en Firebase. Por eso no se carga el SDK
// de Firebase: se lee por REST y la única función que habla con Firebase
// hace GET y nada más. No hay forma de escribir desde acá.
//
// De cada paciente se leen solo nom, ape, tel y email. La ficha clínica
// (fic, ant, trac) no se baja nunca.
(function (global) {
  'use strict';
  const CFG = global.MEK_CONFIG;
  const CAMPOS = ['nom', 'ape', 'tel', 'email'];

  async function leerFirebase(ruta, shallow) {
    const url = CFG.firebaseDb + '/' + ruta + '.json' + (shallow ? '?shallow=true' : '');
    const r = await fetch(url, { method: 'GET', cache: 'no-store' });
    if (!r.ok) throw new Error('Firebase respondió ' + r.status + ' en ' + ruta);
    return r.json();
  }

  async function leerPaciente(ref) {
    const base = CFG.firebasePacientes + '/' + encodeURIComponent(ref) + '/';
    const [nom, ape, tel, email] = await Promise.all(CAMPOS.map((c) => leerFirebase(base + c)));
    const nombre = [nom, ape].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).join(' ');
    return { ref, nombre, telefono: tel == null ? null : String(tel), email: email || null };
  }

  async function enParalelo(lista, n, fn) {
    const out = [];
    let i = 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < lista.length) { const k = i++; out[k] = await fn(lista[k]); }
    }));
    return out;
  }

  // Trae de Firebase los pacientes que todavía no están en el espejo
  // (o todos, si completo = true) y los sube a Supabase.
  // conocidos: Set de refs que ya están en Supabase.
  async function sincronizar(sb, conocidos, completo, avance) {
    const claves = Object.keys(await leerFirebase(CFG.firebasePacientes, true) || {});
    const faltan = completo ? claves : claves.filter((k) => !conocidos.has(k));
    if (!faltan.length) return { nuevos: [], total: claves.length };

    let hechos = 0;
    const leidos = await enParalelo(faltan, 12, async (ref) => {
      const p = await leerPaciente(ref);
      if (avance) avance(++hechos, faltan.length);
      return p;
    });
    const validos = leidos.filter((p) => p.nombre);
    for (let i = 0; i < validos.length; i += 200) {
      const { error } = await sb.rpc('sincronizar_pacientes', { p: validos.slice(i, i + 200) });
      if (error) throw error;
    }
    return { nuevos: validos, total: claves.length };
  }

  global.Pacientes = { sincronizar, leerPaciente };
})(window);
