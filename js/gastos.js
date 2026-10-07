// Gastos. Se cargan por la cola (igual que los cobros): sin internet se
// guardan en el navegador y suben solos.
(function () {
  'use strict';
  const M = window.MEK;
  const sb = M.sb;
  const $ = (s) => document.querySelector(s);
  const TIPOS = { costo_operativo: 'Costo del negocio', retiro_socio: 'Retiro de socio', sueldo: 'Sueldo',
                  pago_tercero: 'Pago a tercero', compra_producto: 'Compra de mercadería', pago_deuda: 'Pago de deuda' };
  const CATEGORIAS = ['alquiler', 'luz', 'gas', 'agua', 'internet', 'teléfono', 'limpieza', 'insumos varios',
                      'publicidad', 'mantenimiento', 'impuestos', 'contador', 'banco y comisiones', 'otros'];
  let usuario = null, medio = null, gastos = [];

  const primerDia = (mes) => mes + '-01';
  function ultimoDia(mes) {
    const [y, m] = mes.split('-').map(Number);
    return new Date(y, m, 0).toLocaleDateString('en-CA');
  }

  async function cargar() {
    const mes = $('#mes').value;
    try {
      gastos = await M.leerTodo('gastos', '*', (q) => q.gte('fecha', primerDia(mes)).lte('fecha', ultimoDia(mes)), 'fecha');
      M.LS.set('gastos.' + mes, gastos);
    } catch (e) {
      gastos = M.LS.get('gastos.' + mes, []);
      if (navigator.onLine) M.toast('No se pudo leer: ' + M.mensaje(e), 'error');
    }
    render();
  }

  function enCola() {
    return window.Cola.leer().filter((o) => o.tipo === 'gasto').map((o) => Object.assign({}, o.payload, {
      id: null, creado_por: usuario.nombre, enCola: true, error: o.error,
    }));
  }
  const anulando = (g) => window.Cola.leer().some((o) => o.tipo === 'anular_gasto' &&
    ((g.id && o.payload.gasto_id === g.id) || (g.client_id && o.payload.client_id === g.client_id)));

  function render() {
    const mes = $('#mes').value;
    const [y, m] = mes.split('-');
    $('#tituloLista').textContent = 'Gastos de ' + new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    const cola = enCola().filter((g) => g.fecha >= primerDia(mes) && g.fecha <= ultimoDia(mes));
    const lista = cola.concat(gastos.filter((g) => !cola.some((c) => c.client_id && c.client_id === g.client_id)))
      .sort((a, b) => (b.fecha > a.fecha ? 1 : b.fecha < a.fecha ? -1 : (b.id || 1e9) - (a.id || 1e9)));
    const vivos = lista.filter((g) => !g.anulado_en && !anulando(g));
    const suma = (f) => M.r2(vivos.filter(f).reduce((a, g) => a + Number(g.monto), 0));

    $('#resumen').innerHTML =
      '<div class="kpi"><small>Costos del negocio</small><b>' + M.plata(suma((g) => g.tipo === 'costo_operativo')) + '</b></div>' +
      '<div class="kpi"><small>Sueldos y pagos a terceros</small><b>' + M.plata(suma((g) => g.tipo === 'sueldo' || g.tipo === 'pago_tercero')) + '</b>' +
        '<div class="det">de las liquidaciones</div></div>' +
      '<div class="kpi"><small>Compras de mercadería</small><b>' + M.plata(suma((g) => g.tipo === 'compra_producto')) + '</b></div>' +
      '<div class="kpi aparte"><small>Retiros de socio (aparte)</small><b>' + M.plata(suma((g) => g.tipo === 'retiro_socio')) + '</b>' +
        '<div class="det">no son costo del negocio</div></div>';

    $('#lista').innerHTML = '<thead><tr><th>Fecha</th><th>Tipo</th><th>Categoría</th><th>Detalle</th><th>Medio</th><th class="num">Monto</th><th></th></tr></thead><tbody>' +
      (lista.length ? lista.map((g) => {
        const anul = g.anulado_en || anulando(g);
        const puede = !anul && !g.liquidacion_id && (!g.compra_id || usuario.rol === 'admin');
        const key = g.id ? 'id:' + g.id : 'c:' + g.client_id;
        return '<tr class="' + (anul ? 'anulado' : '') + '"><td>' + M.fechaCorta(g.fecha) + '</td><td>' + M.esc(TIPOS[g.tipo] || g.tipo) +
          '</td><td>' + M.esc(g.categoria) + '</td><td>' + M.esc(g.descripcion || '') +
          (g.anulado_motivo ? '<div class="tenue">Anulado: ' + M.esc(g.anulado_motivo) + '</div>' : '') +
          (g.enCola ? ' <span class="pill ' + (g.error ? 'mal' : 'espera') + '">' + (g.error ? 'error: ' + M.esc(g.error) : 'sin sincronizar') + '</span>' : '') +
          '</td><td>' + M.esc(g.medio ? M.nombreMedio(g.medio) : '—') + '</td><td class="num">' + M.plata(g.monto) + '</td><td>' +
          (puede ? '<button type="button" class="link" data-anular="' + key + '">anular</button>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="tenue">No hay gastos cargados en este mes.</td></tr>') + '</tbody>';

    const cats = new Set(CATEGORIAS.concat(gastos.map((g) => g.categoria)));
    $('#categorias').innerHTML = [...cats].sort().map((c) => '<option value="' + M.esc(c) + '">').join('');
    renderSync();
  }

  function renderSync() {
    const ops = window.Cola.leer();
    const err = ops.filter((o) => o.error).length;
    const b = $('#sync');
    b.className = 'sync' + (err ? ' mal' : ops.length ? ' espera' : ' ok');
    b.textContent = (navigator.onLine ? '' : 'Sin conexión · ') + (err ? err + ' con error' :
      ops.length ? ops.length + ' sin sincronizar' : '✓ Todo sincronizado');
  }

  function renderMedios() {
    $('#medios').innerHTML = M.MEDIOS.map(([k, n]) =>
      '<button type="button" class="chip' + (medio === k ? ' activo' : '') + '" data-medio="' + k + '">' + n + '</button>').join('');
  }

  async function subir() {
    await window.Cola.procesar(sb);
    await cargar();
  }

  function guardar(ev) {
    ev.preventDefault();
    const monto = M.numero($('#monto').value);
    if (!(monto > 0)) { M.toast('El monto tiene que ser mayor a cero', 'error'); return; }
    if (!$('#categoria').value.trim()) { M.toast('Falta la categoría', 'error'); return; }
    const g = {
      fecha: $('#fecha').value, tipo: $('#tipo').value, categoria: $('#categoria').value.trim(),
      descripcion: $('#descripcion').value.trim() || null, monto, medio,
    };
    if (g.tipo === 'retiro_socio' && !confirm('¿Es un retiro de socio (plata que se lleva una socia), no un gasto del negocio?')) return;
    window.Cola.agregar('gasto', g);
    $('#monto').value = '';
    $('#descripcion').value = '';
    medio = null;
    renderMedios();
    M.toast('Gasto guardado: ' + g.categoria + ' ' + M.plata(monto) + (navigator.onLine ? '' : ' (sin conexión: se sube solo)'), 'ok');
    render();
    subir();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('button');
    if (!t) return;
    if (t.dataset.medio) { medio = medio === t.dataset.medio ? null : t.dataset.medio; renderMedios(); }
    if (t.dataset.anular) {
      const motivo = prompt('¿Por qué se anula? (queda registrado; el gasto no se borra)');
      if (!motivo || !motivo.trim()) return;
      const [k, v] = t.dataset.anular.split(/:(.+)/);
      window.Cola.agregar('anular_gasto', k === 'id' ? { gasto_id: Number(v), motivo: motivo.trim() } : { client_id: v, motivo: motivo.trim() });
      render();
      subir();
    }
    if (t.id === 'sync') subir();
  });

  async function iniciar() {
    usuario = await M.requerirSesion('gastos');
    if (!usuario) return;
    M.salirBoton();
    $('#fecha').value = M.hoy();
    $('#mes').value = M.hoy().slice(0, 7);
    if (usuario.rol !== 'admin') document.querySelectorAll('[data-admin]').forEach((o) => o.remove());
    renderMedios();
    $('#form').addEventListener('submit', guardar);
    $('#mes').addEventListener('change', cargar);
    window.Cola.alCambiar(renderSync);
    window.addEventListener('online', subir);
    window.addEventListener('offline', renderSync);
    setInterval(() => { if (window.Cola.leer().length) subir(); }, 20000);
    await cargar();
    subir();
  }
  iniciar();
})();
