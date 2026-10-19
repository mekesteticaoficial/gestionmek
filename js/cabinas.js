// Cabinas y packs: estado de cada pack por paciente (packs_estado en
// 07_mejoras.sql). "Usar sesión" va por la cola, igual que en Cobro.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  let packs = M.LS.get('packs_estado', []);
  let usuario = null;
  let tratamientos = M.LS.get('catalogo', { tratamientos: [] }).tratamientos || [];

  const dias = (f) => Math.round((new Date(M.hoy()) - new Date(String(f).slice(0, 10))) / 86400000);

  async function cargar() {
    try {
      const { data, error } = await sb.rpc('packs_estado', { p_incluir_terminados: $('#terminados').checked });
      if (error) throw error;
      packs = data || [];
      M.LS.set('packs_estado', packs);
    } catch (e) {
      if (navigator.onLine) M.toast(/packs_estado/.test(e.message || '') ? 'Falta correr 07_mejoras.sql en Supabase' : M.mensaje(e), 'error');
    }
    render();
  }

  // Sesiones usadas acá que todavía no subieron.
  const enCola = (id) => window.Cola.leer().filter((o) => o.tipo === 'venta' && o.payload.items.some((i) => i.tipo === 'pack_sesion' && i.pack_id === id)).length;

  // ¿La sesión necesita profesional? Solo si no es cabina.
  function esCabina(p) {
    const t = tratamientos.find((x) => x.id === p.tratamiento_id);
    return !t || t.categoria === 'cabina';
  }

  function render() {
    const f = M.norm($('#buscar').value);
    const lista = packs.filter((p) => !f || M.norm(p.paciente + ' ' + p.nombre).includes(f));
    const activos = packs.filter((p) => p.estado === 'activo');
    const quedan = activos.reduce((a, p) => a + (p.total - p.usadas - enCola(p.id)), 0);
    const sinVenir = activos.filter((p) => (p.ultima ? dias(p.ultima) : dias(p.fecha_venta)) > 30).length;
    $('#resumen').innerHTML =
      '<div class="kpi destacado"><small>Packs activos</small><b>' + activos.length + '</b></div>' +
      '<div class="kpi"><small>Sesiones por usar</small><b>' + quedan + '</b><div class="det">ya pagadas</div></div>' +
      '<div class="kpi' + (sinVenir ? ' destacado' : '') + '"><small>Sin venir hace más de 30 días</small><b>' + sinVenir + '</b><div class="det">para escribirles</div></div>';

    $('#lista').innerHTML = lista.length ? '<div class="packs-grilla">' + lista.map((p) => {
      const cola = enCola(p.id);
      const usadas = p.usadas + cola;
      const libres = p.total - usadas;
      const ultima = p.ultima ? dias(p.ultima) : null;
      const puntos = p.sesiones.map((s, i) => {
        const usada = s.fecha || i < usadas;
        return '<span class="punto' + (usada ? ' usada' : '') + '" title="Sesión ' + s.numero + (s.fecha ? ': ' + M.fechaCorta(s.fecha) + (s.profesional ? ' · ' + s.profesional : '') : usada ? ': hoy (sin sincronizar)' : ': disponible') + '"></span>';
      }).join('');
      return '<section class="card pack-card' + (p.estado !== 'activo' ? ' terminado' : '') + '">' +
        '<div class="titulo-fila"><div><b>' + M.esc(p.paciente) + '</b><div class="tenue">' + M.esc(p.nombre) + '</div></div>' +
        '<div style="text-align:right"><b style="font-size:1.3rem">' + usadas + ' de ' + p.total + '</b><div class="tenue">' +
        (p.estado === 'activo' ? (libres === 1 ? 'le queda 1' : 'le quedan ' + libres) : p.estado === 'agotado' ? 'terminado' : 'transferido') + '</div></div></div>' +
        '<div class="puntos" aria-label="' + usadas + ' de ' + p.total + ' sesiones usadas">' + puntos + '</div>' +
        '<div class="tenue">Comprado el ' + M.fechaCorta(p.fecha_venta) + (p.transferido_de ? ' · transferido de ' + M.esc(p.transferido_de) : '') +
        (p.ultima ? ' · última sesión ' + (ultima === 0 ? 'hoy' : ultima === 1 ? 'ayer' : 'hace ' + ultima + ' días') : ' · todavía no vino') + '</div>' +
        (p.sesiones.some((s) => s.fecha) ? '<div class="tenue" style="font-size:.8rem;margin-top:4px">' +
          p.sesiones.filter((s) => s.fecha).map((s) => s.numero + 'ª ' + M.fechaCorta(s.fecha).slice(0, 5)).join(' · ') + '</div>' : '') +
        (p.estado === 'activo' && libres > 0 ? '<div class="acciones fila"><button type="button" class="primario" data-usar="' + p.id + '">Usar sesión</button></div>' : '') +
        '</section>';
    }).join('') + '</div>'
      : '<section class="card"><p class="tenue">' + (f ? 'Nadie con ese nombre tiene un pack.' : 'No hay packs activos.') + '</p></section>';
    renderSync();
  }

  function renderSync() {
    const ops = window.Cola.leer();
    const err = ops.filter((o) => o.error).length;
    const b = $('#sync');
    b.className = 'sync' + (err ? ' mal' : ops.length ? ' espera' : ' ok');
    b.textContent = (navigator.onLine ? '' : 'Sin conexión · ') + (err ? err + ' con error' : ops.length ? ops.length + ' sin sincronizar' : '✓ Todo sincronizado');
  }

  function usar(id) {
    const p = packs.find((x) => x.id === id);
    const item = { tipo: 'pack_sesion', pack_id: p.id, cantidad: 1 };
    if (!esCabina(p)) {
      const prof = usuario.profesional_id || M.LS.get('ultimoProf', null);
      if (!prof) { M.toast('Esta sesión necesita quién la hizo: usala desde Cobro', 'error'); return; }
      item.profesional_id = prof;
    }
    if (!confirm('¿Usar una sesión de ' + p.nombre + ' de ' + p.paciente + ' hoy?')) return;
    window.Cola.agregar('venta', { fecha: M.hoy(), paciente_ref: p.paciente_ref,
      paciente: { ref: p.paciente_ref, nombre: p.paciente, telefono: p.telefono }, estado: 'cobrada', pagos: [], items: [item] });
    M.toast('Sesión registrada: ' + p.paciente, 'ok');
    render();
    subir();
  }

  async function subir() { await window.Cola.procesar(sb); await cargar(); }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.usar) usar(Number(t.dataset.usar));
    if (t.id === 'sync') subir();
  });
  document.addEventListener('input', (ev) => { if (ev.target.id === 'buscar') render(); });
  document.addEventListener('change', (ev) => { if (ev.target.id === 'terminados') cargar(); });

  async function iniciar() {
    usuario = await M.requerirSesion('cabinas');
    if (!usuario) return;
    M.salirBoton();
    render();
    window.Cola.alCambiar(renderSync);
    window.addEventListener('online', subir);
    if (!tratamientos.length && navigator.onLine) {
      const { data } = await sb.from('tratamientos').select('id,categoria');
      tratamientos = data || [];
    }
    await cargar();
    if (window.Cola.leer().length) subir();
  }
  iniciar();
})();
