// Turnos del dashboard (Firebase, mek/t) marcados "✓ Atendida".
//
// Igual que js/pacientes.js: solo GET, sin el SDK de Firebase. Desde acá
// no se puede escribir en el dashboard. De cada turno se usa id, nom, tr,
// prof, hora, fecha, tel, obs y estado.
//
// El vínculo con la venta es ventas.turno_ref = 't' + id (la misma clave
// del turno en Firebase). Ver sql/08_turnos.sql.
(function (global) {
  'use strict';
  const CFG = global.MEK_CONFIG;
  const RUTA = 'mek/t';

  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();
  const soloDigitos = (s) => String(s || '').replace(/\D/g, '').slice(-8);

  // Si la base del dashboard tiene índice por fecha, se baja solo el día;
  // si no (Firebase responde 400), se baja todo mek/t y se filtra acá.
  let sinIndice = false;
  async function leerDia(fecha) {
    const base = CFG.firebaseDb + '/' + RUTA + '.json';
    if (!sinIndice) {
      const r = await fetch(base + '?orderBy=' + encodeURIComponent('"fecha"') + '&equalTo=' + encodeURIComponent('"' + fecha + '"'),
        { method: 'GET', cache: 'no-store' });
      if (r.ok) return lista(await r.json(), fecha);
      if (r.status !== 400) throw new Error('Firebase respondió ' + r.status + ' en ' + RUTA);
      sinIndice = true;
    }
    const r = await fetch(base, { method: 'GET', cache: 'no-store' });
    if (!r.ok) throw new Error('Firebase respondió ' + r.status + ' en ' + RUTA);
    return lista(await r.json(), fecha);
  }

  function lista(val, fecha) {
    const todos = Array.isArray(val) ? val : Object.values(val || {});
    return todos.filter((t) => t && t.id != null && t.fecha === fecha).map((t) => ({
      ref: 't' + String(t.id), nom: String(t.nom || '').trim(), tr: String(t.tr || '').trim(),
      prof: t.prof || null, hora: Number(t.hora), tel: t.tel ? String(t.tel) : null,
      obs: t.obs ? String(t.obs) : '', atendido: t.estado === 'atendido',
    })).sort((a, b) => a.hora - b.hora);
  }

  // Paciente del espejo para el turno. El dashboard guarda el nombre tal
  // cual "nom ape" (a veces con dobles espacios o en minúscula), sin id.
  // Devuelve { paciente } si hay una sola, { opciones } si hay varias.
  function paciente(turno, pacientes) {
    const n = norm(turno.nom);
    if (!n) return { opciones: [] };
    let igual = pacientes.filter((p) => norm(p.nombre) === n);
    if (igual.length > 1 && soloDigitos(turno.tel)) {
      const porTel = igual.filter((p) => soloDigitos(p.telefono) === soloDigitos(turno.tel));
      if (porTel.length) igual = porTel;
    }
    if (igual.length === 1) return { paciente: igual[0] };
    // Mismo nombre repetido en el dashboard (fichas duplicadas): todas son
    // la misma persona para el turno, pero que elija quien cobra.
    return { opciones: igual };
  }

  // Tratamiento del catálogo con el mismo nombre que el turno, o null.
  // Depilación no se resuelve sola: faltan las zonas.
  function tratamiento(turno, tratamientos) {
    const n = norm(turno.tr);
    if (!n || esDepilacion(turno)) return null;
    return tratamientos.find((t) => t.categoria !== 'cabina' && norm(t.nombre) === n) || null;
  }
  const esDepilacion = (turno) => /depil|laser/.test(norm(turno.tr));

  // Profesional del sistema para el código del dashboard
  // (silvia, yael, este, juan, otro). 'otro' no se adivina.
  function profesional(codigo, profesionales) {
    const empieza = (pre) => profesionales.find((p) => norm(p.nombre).startsWith(pre));
    if (codigo === 'silvia') return empieza('silvia') || null;
    if (codigo === 'yael') return empieza('yael') || null;
    if (codigo === 'este') return empieza('estefania') || null;
    if (codigo === 'juan') return empieza('juan cruz') || null;
    return null;
  }

  global.Turnos = { leerDia, paciente, tratamiento, profesional, esDepilacion, norm };
})(window);
