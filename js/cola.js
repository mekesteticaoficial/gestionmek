// Cola de operaciones. Todo cobro pasa por acá: primero se guarda en el
// navegador y después se sube. Si no hay internet, queda esperando y se
// sube sola cuando vuelve. Cada operación lleva un id generado acá, así
// que reintentar no duplica (ventas.client_id es único en la base).
//
// Nada sale de la cola sin confirmación del servidor. Si el servidor
// rechaza una operación, queda marcada con el error hasta que alguien
// la revise: no se descarta sola.
(function (global) {
  'use strict';
  const KEY = 'mek.cola.v1';
  const oyentes = [];
  let procesando = false;

  function leer() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
  }
  function escribir(ops) {
    localStorage.setItem(KEY, JSON.stringify(ops));
    oyentes.forEach((f) => f(ops));
  }

  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  // tipo: 'venta' (payload = registrar_venta), 'cobrar' {venta_id|client_id, pagos},
  //       'anular' {venta_id|client_id, motivo},
  //       'gasto' (payload = registrar_gasto), 'anular_gasto' {gasto_id|client_id, motivo},
  //       'pago_cuenta' (payload = registrar_pago_cuenta: pago parcial de una deudora)
  function agregar(tipo, payload) {
    const ops = leer();
    const op = { id: uuid(), tipo, payload, creado: new Date().toISOString(), intentos: 0, error: null };
    if (tipo === 'venta' || tipo === 'gasto' || tipo === 'pago_cuenta') payload.client_id = op.id;
    ops.push(op);
    escribir(ops);
    return op;
  }

  // Una venta pendiente que todavía no subió se cobra en la misma cola.
  function cobrarEnCola(clientId, pagos) {
    const ops = leer();
    const op = ops.find((o) => o.tipo === 'venta' && o.payload.client_id === clientId);
    if (!op) return false;
    op.payload.estado = 'cobrada';
    op.payload.pagos = pagos;
    escribir(ops);
    return true;
  }

  function quitar(id) { escribir(leer().filter((o) => o.id !== id)); }
  function reintentar(id) {
    const ops = leer();
    const op = ops.find((o) => o.id === id);
    if (op) { op.error = null; escribir(ops); }
  }

  // Error de red o de sesión vencida: se reintenta. Error de la base
  // (una validación de registrar_venta): no se reintenta solo.
  function esReintentable(err) {
    if (!err) return false;
    if (err instanceof TypeError) return true;
    const code = err.code || '';
    return !code || code.startsWith('PGRST3') || code === '401' || /fetch|network|jwt/i.test(err.message || '');
  }

  async function idPorClient(sb, clientId, tabla) {
    const { data, error } = await sb.from(tabla || 'ventas').select('id').eq('client_id', clientId).maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('Todavía no subió'), { code: 'espera' });
    return data.id;
  }

  async function enviar(sb, op) {
    const p = op.payload;
    if (op.tipo === 'venta' || op.tipo === 'gasto' || op.tipo === 'pago_cuenta') {
      const fn = { venta: 'registrar_venta', gasto: 'registrar_gasto', pago_cuenta: 'registrar_pago_cuenta' }[op.tipo];
      const { data, error } = await sb.rpc(fn, { p });
      if (error) throw error;
      return data;
    }
    if (op.tipo === 'anular_gasto') {
      const gastoId = p.gasto_id || await idPorClient(sb, p.client_id, 'gastos');
      const { error } = await sb.rpc('anular_gasto', { p_gasto: gastoId, p_motivo: p.motivo });
      if (error) throw error;
      return;
    }
    const ventaId = p.venta_id || await idPorClient(sb, p.client_id);
    const { error } = op.tipo === 'cobrar'
      ? await sb.rpc('cobrar_venta', { p_venta: ventaId, p_pagos: p.pagos })
      : await sb.rpc('anular_venta', { p_venta: ventaId, p_motivo: p.motivo });
    if (error) throw error;
  }

  // Sube en orden. Se frena en la primera que falla por red, para no
  // desordenar (un "anular" no puede llegar antes que su venta).
  async function procesar(sb) {
    if (procesando || !navigator.onLine) return;
    procesando = true;
    try {
      for (const op of leer()) {
        if (op.error) continue;
        try {
          await enviar(sb, op);
          quitar(op.id);
        } catch (err) {
          const ops = leer();
          const o = ops.find((x) => x.id === op.id);
          if (!o) continue;
          o.intentos++;
          if (err.code === 'espera' || esReintentable(err)) { escribir(ops); break; }
          o.error = err.message || String(err);
          escribir(ops);
        }
      }
    } finally {
      procesando = false;
    }
  }

  global.Cola = {
    leer, agregar, cobrarEnCola, quitar, reintentar, procesar, uuid,
    alCambiar: (f) => oyentes.push(f),
  };
})(window);
