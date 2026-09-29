-- =====================================================================
-- MEK Estética — INSTALACIÓN COMPLETA
--
-- Un solo archivo: crea toda la estructura y carga todos los datos.
-- Reemplaza a 01_esquema.sql, 02, 03 y carga_inicial_v2.sql.
--
-- Se puede correr desde cualquier estado: si quedó algo a medias de
-- intentos anteriores, lo borra y lo rehace.
-- Si ya hubiera ventas cargadas, se detiene sin tocar nada.
-- =====================================================================

DO $guard$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('public.ventas') IS NOT NULL THEN
    -- SQL dinamico: no se analiza si la tabla todavia no existe.
    EXECUTE 'SELECT count(*) FROM ventas' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'Hay % ventas cargadas. Este archivo es solo para la instalacion inicial.', n;
    END IF;
  END IF;
END $guard$;

-- Limpieza: deja la base como recien creada.
DROP VIEW IF EXISTS v_sin_comision, v_a_pagar_terceros, v_ingreso_neto,
                    v_comisiones_pendientes, v_packs_activos CASCADE;

DROP TABLE IF EXISTS auditoria, liquidacion_items, liquidaciones, gastos,
                     item_zonas, venta_items, ventas, pack_sesiones, packs,
                     compra_items, compras, productos, escala_depilacion,
                     promo_zonas, promos_depilacion, zonas_depilacion,
                     reglas_comision, precios_tratamiento, tratamientos,
                     profesionales, pacientes, config CASCADE;

DROP FUNCTION IF EXISTS fn_auditar() CASCADE;
DROP FUNCTION IF EXISTS fn_liq_cerrada() CASCADE;
DROP FUNCTION IF EXISTS fn_item_liquidado() CASCADE;

DROP TYPE IF EXISTS modelo_cobro, tipo_comision, sexo_zona, tipo_producto,
                    modalidad_producto, condicion_compra, estado_pago,
                    estado_pack, estado_venta, origen_venta, tipo_item,
                    tipo_gasto, estado_liquidacion CASCADE;


-- ---------------------------------------------------------------------
-- BLOQUE 1 — IDENTIDAD
-- ---------------------------------------------------------------------

-- Espejo de solo lectura de mek/p (Firebase). Las fichas clínicas NO
-- viven acá: viven en el dashboard y solo ahí.
CREATE TABLE pacientes (
  ref              text PRIMARY KEY,          -- el 'i123' de Firebase
  nombre           text NOT NULL,
  telefono         text,
  email            text,
  sincronizado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pacientes_nombre ON pacientes (lower(nombre));

CREATE TYPE modelo_cobro AS ENUM (
  'interno',            -- Silvia, Yael. Cobra MEK, MEK paga comisión.
  'invitado_cobra_mek', -- Márquez, Estefanía. Cobra MEK, MEK le debe su parte.
  'invitado_cobra_el'   -- Masajista, lifting/uñas. No pasa por nuestra caja.
);

CREATE TABLE profesionales (
  id       serial PRIMARY KEY,
  nombre   text NOT NULL UNIQUE,
  modelo   modelo_cobro NOT NULL,
  activo   boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------
-- BLOQUE 2 — CATÁLOGO Y PRECIOS
-- ---------------------------------------------------------------------

CREATE TABLE tratamientos (
  id         serial PRIMARY KEY,
  nombre     text NOT NULL UNIQUE,
  categoria  text NOT NULL,     -- 'facial','corporal','capilar','inyectable',...
  activo     boolean NOT NULL DEFAULT true
);

-- Historial de precios. Nunca se pisa un precio: se agrega uno nuevo.
-- Así una venta de agosto se puede auditar con el precio de agosto.
CREATE TABLE precios_tratamiento (
  id              serial PRIMARY KEY,
  tratamiento_id  int NOT NULL REFERENCES tratamientos(id),
  precio          numeric(12,2) NOT NULL CHECK (precio >= 0),
  vigente_desde   date NOT NULL,
  UNIQUE (tratamiento_id, vigente_desde)
);

CREATE TYPE tipo_comision AS ENUM ('porcentaje', 'monto_fijo');

-- Regla de comisión por profesional. tratamiento_id NULL = aplica a toda
-- la categoría. La regla más específica gana.
CREATE TABLE reglas_comision (
  id               serial PRIMARY KEY,
  profesional_id   int NOT NULL REFERENCES profesionales(id),
  categoria        text,
  tratamiento_id   int REFERENCES tratamientos(id),
  tipo             tipo_comision NOT NULL,
  valor            numeric(12,2) NOT NULL CHECK (valor >= 0),
  vigente_desde    date NOT NULL,
  CHECK (categoria IS NOT NULL OR tratamiento_id IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- BLOQUE 3 — DEPILACIÓN (catálogo; las ventas van al libro único)
-- ---------------------------------------------------------------------

CREATE TYPE sexo_zona AS ENUM ('mujer', 'hombre', 'ambos');

CREATE TABLE zonas_depilacion (
  id             serial PRIMARY KEY,
  nombre         text NOT NULL,
  sexo           sexo_zona NOT NULL,
  precio         numeric(12,2) NOT NULL CHECK (precio >= 0),
  vigente_desde  date NOT NULL,
  activo         boolean NOT NULL DEFAULT true,
  UNIQUE (nombre, sexo, vigente_desde)
);

CREATE TABLE promos_depilacion (
  id             serial PRIMARY KEY,
  nombre         text NOT NULL,
  sexo           sexo_zona NOT NULL,
  -- NULL = el precio sale de la fórmula sobre las zonas.
  -- Con valor = precio clavado a mano por decisión comercial.
  precio_fijado  numeric(12,2) CHECK (precio_fijado >= 0),
  motivo_fijado  text,
  revisar        boolean NOT NULL DEFAULT false,
  activo         boolean NOT NULL DEFAULT true,
  UNIQUE (nombre, sexo)
);

CREATE TABLE promo_zonas (
  promo_id  int NOT NULL REFERENCES promos_depilacion(id) ON DELETE CASCADE,
  zona_id   int NOT NULL REFERENCES zonas_depilacion(id),
  PRIMARY KEY (promo_id, zona_id)
);

-- Escala de descuento por posición (zona más cara = posición 1).
CREATE TABLE escala_depilacion (
  posicion     int PRIMARY KEY CHECK (posicion >= 1),
  porcentaje   numeric(5,2) NOT NULL CHECK (porcentaje > 0 AND porcentaje <= 100),
  vigente_desde date NOT NULL
);

CREATE TABLE config (
  clave  text PRIMARY KEY,
  valor  text NOT NULL
);

-- ---------------------------------------------------------------------
-- BLOQUE 4 — PRODUCTOS, COMPRAS Y STOCK
-- ---------------------------------------------------------------------

CREATE TYPE tipo_producto AS ENUM ('reventa', 'insumo_cabina', 'descartable');
CREATE TYPE modalidad_producto AS ENUM ('propio', 'consignacion');

CREATE TABLE productos (
  id                     serial PRIMARY KEY,
  nombre                 text NOT NULL,
  laboratorio            text,
  codigo_barras          text,
  tipo                   tipo_producto NOT NULL,
  modalidad              modalidad_producto NOT NULL DEFAULT 'propio',
  unidad_compra          text,          -- 'pote 320g', 'bidón 1kg', 'unidad'
  -- Cuántas unidades de VENTA salen de una unidad de COMPRA.
  -- Hidrosomas: entra un pote de 320g, salen N frascos.
  -- NULL = todavía no lo sabemos. Nunca asumir 1.
  fracciones_por_unidad  numeric(10,3) CHECK (fracciones_por_unidad > 0),
  -- Cuántas sesiones rinde una unidad de compra (insumos de cabina).
  rinde_sesiones         numeric(10,2) CHECK (rinde_sesiones > 0),
  precio_venta           numeric(12,2) CHECK (precio_venta >= 0),
  -- Margen acordado cuando modalidad = 'consignacion'.
  margen_consignacion    numeric(5,2),
  stock_actual           numeric(12,3) NOT NULL DEFAULT 0,
  costo_promedio         numeric(12,2),  -- ponderado, por unidad de VENTA
  activo                 boolean NOT NULL DEFAULT true
);

CREATE TYPE condicion_compra AS ENUM ('contado', 'cuenta_corriente');
CREATE TYPE estado_pago AS ENUM ('pendiente', 'pagado');

CREATE TABLE compras (
  id            serial PRIMARY KEY,
  fecha         date NOT NULL,
  proveedor     text NOT NULL,
  nro_remito    text,
  condicion     condicion_compra NOT NULL,
  vencimiento   date,               -- para cuenta corriente
  total         numeric(12,2) NOT NULL CHECK (total >= 0),
  estado        estado_pago NOT NULL DEFAULT 'pendiente',
  pagada_en     date,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  CHECK (condicion = 'contado' OR vencimiento IS NOT NULL)
);

CREATE TABLE compra_items (
  id                    serial PRIMARY KEY,
  compra_id             int NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  producto_id           int NOT NULL REFERENCES productos(id),
  cantidad_pedida       numeric(12,3) NOT NULL CHECK (cantidad_pedida > 0),
  -- Puede diferir de lo pedido. El caso de las 11 agujas que fueron 10.
  cantidad_recibida     numeric(12,3) CHECK (cantidad_recibida >= 0),
  precio_unitario       numeric(12,2) NOT NULL CHECK (precio_unitario >= 0),
  descuento             numeric(12,2) NOT NULL DEFAULT 0,
  -- Costo real pagado por unidad de compra, ya neto de descuento.
  -- Es lo que alimenta costo_promedio. Nunca el precio de lista.
  costo_final_unitario  numeric(12,2) NOT NULL CHECK (costo_final_unitario >= 0)
);

-- ---------------------------------------------------------------------
-- BLOQUE 5 — PACKS Y CABINAS
-- ---------------------------------------------------------------------

CREATE TYPE estado_pack AS ENUM ('activo', 'agotado', 'transferido', 'anulado');

CREATE TABLE packs (
  id                serial PRIMARY KEY,
  paciente_ref      text NOT NULL REFERENCES pacientes(ref),
  nombre            text NOT NULL,          -- 'Cabina 5x10min', 'Plan Contorno'
  sesiones_totales  int NOT NULL CHECK (sesiones_totales > 0),
  precio_pagado     numeric(12,2) NOT NULL CHECK (precio_pagado >= 0),
  venta_id          int,                    -- FK más abajo (venta que lo pagó)
  estado            estado_pack NOT NULL DEFAULT 'activo',
  fecha_venta       date NOT NULL,
  transferido_de    text REFERENCES pacientes(ref),
  creado_en         timestamptz NOT NULL DEFAULT now()
);

-- Una fila por sesión, creadas al vender el pack.
-- consumida_en NULL = todavía disponible.
CREATE TABLE pack_sesiones (
  id              serial PRIMARY KEY,
  pack_id         int NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  numero          int NOT NULL CHECK (numero > 0),
  consumida_en    date,
  profesional_id  int REFERENCES profesionales(id),
  venta_item_id   int,                      -- FK más abajo
  UNIQUE (pack_id, numero)
);

-- ---------------------------------------------------------------------
-- BLOQUE 6 — EL LIBRO ÚNICO
-- ---------------------------------------------------------------------

CREATE TYPE estado_venta AS ENUM ('pendiente', 'cobrada', 'anulada');
CREATE TYPE origen_venta AS ENUM ('dashboard', 'manual');

CREATE TABLE ventas (
  id            serial PRIMARY KEY,
  fecha         date NOT NULL,
  paciente_ref  text NOT NULL REFERENCES pacientes(ref),
  medio_pago    text,                       -- NULL mientras esté pendiente
  estado        estado_venta NOT NULL DEFAULT 'pendiente',
  origen        origen_venta NOT NULL,
  turno_ref     text,                       -- el 't456' del dashboard
  nota          text,
  creado_por    text NOT NULL,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  cobrado_en    timestamptz,
  CHECK (estado <> 'cobrada' OR medio_pago IS NOT NULL)
);
CREATE INDEX idx_ventas_fecha ON ventas (fecha);
CREATE INDEX idx_ventas_estado ON ventas (estado) WHERE estado = 'pendiente';
CREATE UNIQUE INDEX idx_ventas_turno ON ventas (turno_ref) WHERE turno_ref IS NOT NULL;

CREATE TYPE tipo_item AS ENUM (
  'tratamiento',
  'depilacion',     -- va acá adentro, no en una tabla aparte
  'producto',
  'pack_venta',     -- la venta del pack (entra la plata)
  'pack_sesion',    -- consumo de una sesión (se devenga la comisión)
  'cabina',
  'consulta'
);

CREATE TABLE venta_items (
  id              serial PRIMARY KEY,
  venta_id        int NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  tipo            tipo_item NOT NULL,
  descripcion     text NOT NULL,

  tratamiento_id  int REFERENCES tratamientos(id),
  promo_id        int REFERENCES promos_depilacion(id),  -- NULL = combinación libre
  producto_id     int REFERENCES productos(id),
  pack_id         int REFERENCES packs(id),
  cantidad        numeric(10,3) NOT NULL DEFAULT 1,

  -- REGLA 1: los dos precios, siempre.
  precio_lista    numeric(12,2) NOT NULL CHECK (precio_lista >= 0),
  precio_cobrado  numeric(12,2) NOT NULL CHECK (precio_cobrado >= 0),

  -- REGLA 2: congelados al momento del cobro. No se recalculan nunca.
  profesional_id  int REFERENCES profesionales(id),
  comision_tipo   tipo_comision,
  comision_valor  numeric(12,2),   -- el % o el monto fijo, como estaba ese día
  comision_monto  numeric(12,2) NOT NULL DEFAULT 0 CHECK (comision_monto >= 0),

  -- REGLA 4: lo que le corresponde al tercero. NULL si no aplica.
  tercero_monto   numeric(12,2) CHECK (tercero_monto >= 0),

  -- NULL = sin dato. Nunca cero por defecto: un margen sin costo cargado
  -- se muestra como "sin dato", jamás como un número inventado.
  costo_insumo    numeric(12,2),

  creado_en       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_items_venta ON venta_items (venta_id);
CREATE INDEX idx_items_prof ON venta_items (profesional_id);

-- Qué zonas se hicieron realmente. Existe aunque no haya promo.
-- Esto es lo que mata "Promo Especial".
CREATE TABLE item_zonas (
  venta_item_id  int NOT NULL REFERENCES venta_items(id) ON DELETE CASCADE,
  zona_id        int NOT NULL REFERENCES zonas_depilacion(id),
  precio_zona    numeric(12,2) NOT NULL,   -- el precio de lista de ese día
  PRIMARY KEY (venta_item_id, zona_id)
);

ALTER TABLE packs
  ADD CONSTRAINT fk_packs_venta FOREIGN KEY (venta_id) REFERENCES ventas(id);
ALTER TABLE pack_sesiones
  ADD CONSTRAINT fk_sesion_item FOREIGN KEY (venta_item_id) REFERENCES venta_items(id);

-- ---------------------------------------------------------------------
-- BLOQUE 7 — GASTOS Y LIQUIDACIONES
-- ---------------------------------------------------------------------

CREATE TYPE tipo_gasto AS ENUM (
  'costo_operativo',
  'sueldo',
  'pago_tercero',
  'compra_producto',
  'retiro_socio'      -- REGLA 5: no es costo del negocio
);

CREATE TABLE gastos (
  id               serial PRIMARY KEY,
  fecha            date NOT NULL,
  tipo             tipo_gasto NOT NULL,
  categoria        text NOT NULL,
  descripcion      text,
  monto            numeric(12,2) NOT NULL CHECK (monto >= 0),
  profesional_id   int REFERENCES profesionales(id),
  compra_id        int REFERENCES compras(id),
  liquidacion_id   int,                    -- FK más abajo
  creado_por       text NOT NULL,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_gastos_fecha ON gastos (fecha);

CREATE TYPE estado_liquidacion AS ENUM ('abierta', 'cerrada', 'pagada');

CREATE TABLE liquidaciones (
  id              serial PRIMARY KEY,
  profesional_id  int NOT NULL REFERENCES profesionales(id),
  desde           date NOT NULL,
  hasta           date NOT NULL,
  total           numeric(12,2) NOT NULL CHECK (total >= 0),
  ajustes         numeric(12,2) NOT NULL DEFAULT 0,  -- correcciones de períodos cerrados
  estado          estado_liquidacion NOT NULL DEFAULT 'abierta',
  cerrada_en      timestamptz,
  pagada_en       date,
  CHECK (hasta >= desde),
  CHECK (estado = 'abierta' OR cerrada_en IS NOT NULL)
);
CREATE UNIQUE INDEX idx_liq_periodo
  ON liquidaciones (profesional_id, desde, hasta);

-- Qué comisiones entraron en cada liquidación. Una comisión no puede
-- entrar en dos liquidaciones distintas.
CREATE TABLE liquidacion_items (
  liquidacion_id  int NOT NULL REFERENCES liquidaciones(id) ON DELETE CASCADE,
  venta_item_id   int NOT NULL REFERENCES venta_items(id),
  monto           numeric(12,2) NOT NULL,
  PRIMARY KEY (liquidacion_id, venta_item_id)
);
CREATE UNIQUE INDEX idx_liqitem_unico ON liquidacion_items (venta_item_id);

ALTER TABLE gastos
  ADD CONSTRAINT fk_gasto_liq FOREIGN KEY (liquidacion_id) REFERENCES liquidaciones(id);

-- ---------------------------------------------------------------------
-- BLOQUE 8 — AUDITORÍA
-- Todo lo que toca plata queda registrado. El sueldo depende de esto.
-- ---------------------------------------------------------------------

CREATE TABLE auditoria (
  id          bigserial PRIMARY KEY,
  tabla       text NOT NULL,
  registro_id text NOT NULL,
  accion      text NOT NULL,        -- 'insert','update','delete'
  antes       jsonb,
  despues     jsonb,
  usuario     text,
  cuando      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auditoria_cuando ON auditoria (cuando);

CREATE OR REPLACE FUNCTION fn_auditar() RETURNS trigger AS $$
DECLARE
  v_antes   jsonb;
  v_despues jsonb;
  v_id      text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_antes := to_jsonb(OLD); v_id := OLD.id::text;
  ELSIF TG_OP = 'INSERT' THEN
    v_despues := to_jsonb(NEW); v_id := NEW.id::text;
  ELSE
    v_antes := to_jsonb(OLD); v_despues := to_jsonb(NEW); v_id := NEW.id::text;
  END IF;

  INSERT INTO auditoria (tabla, registro_id, accion, antes, despues, usuario)
  VALUES (TG_TABLE_NAME, v_id, lower(TG_OP), v_antes, v_despues,
          current_setting('app.usuario', true));

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER tg_aud_ventas AFTER INSERT OR UPDATE OR DELETE ON ventas
  FOR EACH ROW EXECUTE FUNCTION fn_auditar();
CREATE TRIGGER tg_aud_items AFTER INSERT OR UPDATE OR DELETE ON venta_items
  FOR EACH ROW EXECUTE FUNCTION fn_auditar();
CREATE TRIGGER tg_aud_gastos AFTER INSERT OR UPDATE OR DELETE ON gastos
  FOR EACH ROW EXECUTE FUNCTION fn_auditar();
CREATE TRIGGER tg_aud_liq AFTER INSERT OR UPDATE OR DELETE ON liquidaciones
  FOR EACH ROW EXECUTE FUNCTION fn_auditar();

-- Una liquidación cerrada no se toca. Las correcciones de un período
-- cerrado van como ajuste en el período siguiente.
CREATE OR REPLACE FUNCTION fn_liq_cerrada() RETURNS trigger AS $$
BEGIN
  IF OLD.estado IN ('cerrada','pagada')
     AND (NEW.total <> OLD.total OR NEW.desde <> OLD.desde OR NEW.hasta <> OLD.hasta)
  THEN
    RAISE EXCEPTION 'Liquidación % ya cerrada: el monto no se modifica. Cargar un ajuste en el período siguiente.', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER tg_liq_cerrada BEFORE UPDATE ON liquidaciones
  FOR EACH ROW EXECUTE FUNCTION fn_liq_cerrada();

-- Una comisión ya liquidada no se puede modificar.
CREATE OR REPLACE FUNCTION fn_item_liquidado() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM liquidacion_items li
             JOIN liquidaciones l ON l.id = li.liquidacion_id
             WHERE li.venta_item_id = OLD.id AND l.estado IN ('cerrada','pagada'))
     AND NEW.comision_monto <> OLD.comision_monto
  THEN
    RAISE EXCEPTION 'El ítem % ya fue liquidado: la comisión no se modifica.', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER tg_item_liquidado BEFORE UPDATE ON venta_items
  FOR EACH ROW EXECUTE FUNCTION fn_item_liquidado();

-- ---------------------------------------------------------------------
-- VISTAS
-- ---------------------------------------------------------------------

-- Lo que le debemos a cada tercero y todavía no le pagamos.
CREATE VIEW v_a_pagar_terceros AS
SELECT p.nombre AS profesional,
       sum(i.tercero_monto) AS total_adeudado,
       count(*) AS operaciones,
       min(v.fecha) AS desde
FROM venta_items i
JOIN ventas v ON v.id = i.venta_id
JOIN profesionales p ON p.id = i.profesional_id
LEFT JOIN liquidacion_items li ON li.venta_item_id = i.id
WHERE i.tercero_monto IS NOT NULL
  AND v.estado = 'cobrada'
  AND li.venta_item_id IS NULL
GROUP BY p.nombre;

-- Ingreso REAL de MEK. En terceros muestra lo que queda, no lo que entró.
CREATE VIEW v_ingreso_neto AS
SELECT v.fecha,
       i.tipo,
       i.precio_cobrado                                  AS bruto_cobrado,
       COALESCE(i.tercero_monto, 0)                      AS para_tercero,
       i.comision_monto                                  AS comision,
       i.precio_cobrado
         - COALESCE(i.tercero_monto, 0)
         - i.comision_monto
         - COALESCE(i.costo_insumo, 0)                   AS neto_mek,
       (i.costo_insumo IS NULL)                          AS costo_sin_dato
FROM venta_items i
JOIN ventas v ON v.id = i.venta_id
WHERE v.estado = 'cobrada';

-- Comisiones de la semana de Yael. Una sola suma, sin rangos fijos.
CREATE VIEW v_comisiones_pendientes AS
SELECT p.nombre AS profesional, v.fecha, i.id AS item_id,
       i.descripcion, i.comision_monto
FROM venta_items i
JOIN ventas v ON v.id = i.venta_id
JOIN profesionales p ON p.id = i.profesional_id
LEFT JOIN liquidacion_items li ON li.venta_item_id = i.id
WHERE p.modelo = 'interno'
  AND v.estado = 'cobrada'
  AND i.comision_monto > 0
  AND li.venta_item_id IS NULL;

-- Packs con sesiones disponibles.
CREATE VIEW v_packs_activos AS
SELECT pk.id, pk.paciente_ref, pa.nombre AS paciente, pk.nombre AS pack,
       pk.sesiones_totales,
       count(s.id) FILTER (WHERE s.consumida_en IS NULL) AS disponibles,
       max(s.consumida_en) AS ultima_sesion
FROM packs pk
JOIN pacientes pa ON pa.ref = pk.paciente_ref
JOIN pack_sesiones s ON s.pack_id = pk.id
WHERE pk.estado = 'activo'
GROUP BY pk.id, pk.paciente_ref, pa.nombre, pk.nombre, pk.sesiones_totales;


-- ---------------------------------------------------------------------
-- COLUMNAS PARA PRECIO VARIABLE
-- Liposonix se cobra según cantidad de disparos ($70.000 a $85.000).
-- Remoción de tatuajes se presupuesta según el tamaño, sin rango.
-- ---------------------------------------------------------------------
ALTER TABLE tratamientos
  ADD COLUMN IF NOT EXISTS precio_variable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS precio_min numeric(12,2),
  ADD COLUMN IF NOT EXISTS precio_max numeric(12,2);
ALTER TABLE tratamientos DROP CONSTRAINT IF EXISTS ck_rango;
ALTER TABLE tratamientos ADD CONSTRAINT ck_rango CHECK (
    precio_min IS NULL OR precio_max IS NULL OR precio_max >= precio_min);


-- ---------------------------------------------------------------------
-- PROFESIONALES
-- ---------------------------------------------------------------------
INSERT INTO profesionales (nombre, modelo) VALUES
  ('Silvia Orsi',            'interno'),
  ('Yael Juárez',            'interno'),
  ('Estefanía',              'invitado_cobra_mek'),
  ('Dr. Juan Ignacio Márquez','invitado_cobra_mek'),
  ('Masajista',              'invitado_cobra_el'),
  ('Lifting / perfilado / uñas','invitado_cobra_el');

-- ---------------------------------------------------------------------
-- REGLAS DE COMISIÓN (por categoría)
-- Los montos fijos —truSculpt, INDIBA facial, meso capilar— se cargan
-- junto con los tratamientos, cuando esté confirmada la lista.
-- ---------------------------------------------------------------------
INSERT INTO reglas_comision (profesional_id, categoria, tipo, valor, vigente_desde)
SELECT id, 'facial', 'porcentaje'::tipo_comision, 25, DATE '2026-10-01' FROM profesionales WHERE nombre='Yael Juárez'
UNION ALL
SELECT id, 'corporal', 'porcentaje'::tipo_comision, 30, DATE '2026-10-01' FROM profesionales WHERE nombre='Yael Juárez'
UNION ALL
SELECT id, 'depilacion', 'porcentaje'::tipo_comision, 30, DATE '2026-10-01' FROM profesionales WHERE nombre='Yael Juárez';

-- Terceros: el % que se lleva el profesional (no lo que queda para MEK).
INSERT INTO reglas_comision (profesional_id, categoria, tipo, valor, vigente_desde)
SELECT id, 'plasma',    'porcentaje'::tipo_comision, 50, DATE '2026-10-01' FROM profesionales WHERE nombre='Estefanía'
UNION ALL
SELECT id, 'tatuajes',  'porcentaje'::tipo_comision, 40, DATE '2026-10-01' FROM profesionales WHERE nombre='Estefanía'
UNION ALL
SELECT id, 'masajes',   'porcentaje'::tipo_comision, 70, DATE '2026-10-01' FROM profesionales WHERE nombre='Masajista'
UNION ALL
SELECT id, 'estetica_externa','porcentaje'::tipo_comision, 70, DATE '2026-10-01' FROM profesionales WHERE nombre='Lifting / perfilado / uñas';

-- ---------------------------------------------------------------------
-- ZONAS DE DEPILACIÓN — folleto vigente
-- 'Cavado completo' incluye la tira de cola (confirmado por Franco).
-- 'Axilas mujer' son las dos (confirmado por Franco).
-- ---------------------------------------------------------------------
INSERT INTO zonas_depilacion (nombre, sexo, precio, vigente_desde) VALUES
  -- Extremidades superiores
  ('Brazo completo',      'mujer',  21000, DATE '2026-10-01'),
  ('Medio brazo',         'mujer',  19000, DATE '2026-10-01'),
  ('Brazo completo',      'hombre', 23000, DATE '2026-10-01'),
  ('Medio brazo',         'hombre', 20000, DATE '2026-10-01'),
  -- Pelvis
  ('Glúteos',             'ambos',  17000, DATE '2026-10-01'),
  ('Cavado simple bikini','mujer',  19000, DATE '2026-10-01'),
  ('Cavado completo',     'mujer',  24000, DATE '2026-10-01'),
  ('Pelvis',              'hombre', 22000, DATE '2026-10-01'),
  -- Extremidades inferiores
  ('Media pierna',        'mujer',  19000, DATE '2026-10-01'),
  ('Pierna entera',       'mujer',  23000, DATE '2026-10-01'),
  ('Media pierna',        'hombre', 21000, DATE '2026-10-01'),
  ('Pierna entera',       'hombre', 25000, DATE '2026-10-01'),  -- a revisar por tiempo real
  -- Rostro
  ('Bozo',                'mujer',  15000, DATE '2026-10-01'),
  ('Mentón',              'ambos',  14000, DATE '2026-10-01'),
  ('Rostro completo',     'mujer',  25000, DATE '2026-10-01'),
  ('Barba',               'hombre', 25000, DATE '2026-10-01'),
  -- Tronco
  ('Axila',               'hombre', 18000, DATE '2026-10-01'),
  ('Axilas',              'mujer',  17000, DATE '2026-10-01'),
  ('Cuello',              'ambos',  14000, DATE '2026-10-01'),
  ('Hombros',             'hombre', 17000, DATE '2026-10-01'),
  ('Pecho',               'hombre', 23000, DATE '2026-10-01'),
  ('Abdomen',             'ambos',  22000, DATE '2026-10-01'),
  ('Tira de panza',       'ambos',  12000, DATE '2026-10-01'),
  ('Espalda',             'hombre', 28000, DATE '2026-10-01'),
  ('Espalda',             'mujer',  25000, DATE '2026-10-01'),
  ('Media espalda',       'hombre', 21000, DATE '2026-10-01'),
  ('Media espalda',       'mujer',  19000, DATE '2026-10-01');

-- ---------------------------------------------------------------------
-- ESCALA DE DESCUENTO
-- Se ordenan las zonas de más cara a más barata.
-- Sirve para cotizar cualquier combinación libre: promo + zona extra,
-- promo - zona, o un armado que no existe como promo.
-- ---------------------------------------------------------------------
INSERT INTO escala_depilacion (posicion, porcentaje, vigente_desde) VALUES
  (1, 100, DATE '2026-10-01'),
  (2,  40, DATE '2026-10-01'),
  (3,  30, DATE '2026-10-01'),
  (4,  25, DATE '2026-10-01');   -- de la 4ª en adelante

INSERT INTO config (clave, valor) VALUES
  ('depilacion_piso_promo', '30000'),
  ('depilacion_redondeo',   '1000');

-- ---------------------------------------------------------------------
-- PROMOS — lista de octubre 2026 aprobada
-- Las 14 tienen precio fijado porque fueron decididas una por una.
-- La escala de arriba cotiza todo lo que NO sea una de estas 14.
-- ---------------------------------------------------------------------
INSERT INTO promos_depilacion (nombre, sexo, precio_fijado, motivo_fijado, revisar) VALUES
  ('Promo 1', 'mujer',  37000, 'Lista octubre 2026', false),
  ('Promo 2', 'mujer',  34000, 'Lista octubre 2026', false),
  ('Promo 3', 'mujer',  36000, 'Lista octubre 2026', false),
  ('Promo 4', 'mujer',  31000, 'Lista octubre 2026', false),
  ('Promo 5', 'mujer',  23000, 'Lista octubre 2026 — escalón hacia rostro completo', false),
  ('Promo 6', 'mujer',  28000, 'SIN DECIDIR: solo 6% de descuento contra 24% de Promo 4', true),
  ('Promo 7', 'mujer',  46000, 'Lista octubre 2026', false),
  ('Promo 8', 'mujer',  42000, 'Lista octubre 2026', false),
  ('Promo 1', 'hombre', 47000, 'Lista octubre 2026', false),
  ('Promo 2', 'hombre', 43000, 'Lista octubre 2026 — sin cambio', false),
  ('Promo 3', 'hombre', 37000, 'Lista octubre 2026 — sin cambio', false),
  ('Promo 5', 'hombre', 40000, 'Sin cambio. Depende del precio real de pierna hombre', true),
  ('Promo 6', 'hombre', 32000, 'Lista octubre 2026 — sin cambio', false),
  ('Promo 7', 'hombre', 55000, 'Sin cambio. Depende del precio real de pierna hombre', true);

-- Composición de cada promo
INSERT INTO promo_zonas (promo_id, zona_id)
WITH z AS (SELECT id, nombre, sexo::text AS sexo FROM zonas_depilacion),
     pr AS (SELECT id, nombre, sexo::text AS sexo FROM promos_depilacion)
SELECT pr.id, z.id FROM pr JOIN z ON true
WHERE (pr.nombre, pr.sexo, z.nombre, z.sexo) IN (
  -- MUJER
  ('Promo 1','mujer','Cavado completo','mujer'),
  ('Promo 1','mujer','Pierna entera','mujer'),
  ('Promo 1','mujer','Axilas','mujer'),

  ('Promo 2','mujer','Cavado completo','mujer'),
  ('Promo 2','mujer','Axilas','mujer'),
  ('Promo 2','mujer','Bozo','mujer'),

  ('Promo 3','mujer','Cavado completo','mujer'),
  ('Promo 3','mujer','Media pierna','mujer'),
  ('Promo 3','mujer','Axilas','mujer'),

  ('Promo 4','mujer','Cavado completo','mujer'),
  ('Promo 4','mujer','Axilas','mujer'),

  ('Promo 5','mujer','Bozo','mujer'),
  ('Promo 5','mujer','Mentón','ambos'),

  ('Promo 6','mujer','Axilas','mujer'),
  ('Promo 6','mujer','Bozo','mujer'),

  ('Promo 7','mujer','Cavado completo','mujer'),
  ('Promo 7','mujer','Pierna entera','mujer'),
  ('Promo 7','mujer','Axilas','mujer'),
  ('Promo 7','mujer','Rostro completo','mujer'),

  ('Promo 8','mujer','Cavado completo','mujer'),
  ('Promo 8','mujer','Pierna entera','mujer'),
  ('Promo 8','mujer','Axilas','mujer'),
  ('Promo 8','mujer','Bozo','mujer'),

  -- HOMBRE
  ('Promo 1','hombre','Espalda','hombre'),
  ('Promo 1','hombre','Pecho','hombre'),
  ('Promo 1','hombre','Abdomen','ambos'),
  ('Promo 1','hombre','Hombros','hombre'),

  ('Promo 2','hombre','Espalda','hombre'),
  ('Promo 2','hombre','Pecho','hombre'),
  ('Promo 2','hombre','Abdomen','ambos'),

  ('Promo 3','hombre','Espalda','hombre'),
  ('Promo 3','hombre','Hombros','hombre'),

  ('Promo 5','hombre','Pierna entera','hombre'),
  ('Promo 5','hombre','Pelvis','hombre'),

  ('Promo 6','hombre','Pecho','hombre'),
  ('Promo 6','hombre','Abdomen','ambos'),

  ('Promo 7','hombre','Espalda','hombre'),
  ('Promo 7','hombre','Pecho','hombre'),
  ('Promo 7','hombre','Abdomen','ambos'),
  ('Promo 7','hombre','Pierna entera','hombre')
);

-- ---------------------------------------------------------------------
-- CABINA SOLAR
-- ---------------------------------------------------------------------
INSERT INTO tratamientos (nombre, categoria) VALUES
  ('Cabina solar 5 min',  'cabina'),
  ('Cabina solar 8 min',  'cabina'),
  ('Cabina solar 10 min', 'cabina');

INSERT INTO precios_tratamiento (tratamiento_id, precio, vigente_desde)
SELECT id, CASE nombre
             WHEN 'Cabina solar 5 min'  THEN 10000
             WHEN 'Cabina solar 8 min'  THEN 12000
             WHEN 'Cabina solar 10 min' THEN 15000
           END,
       DATE '2026-10-01'
FROM tratamientos WHERE categoria = 'cabina';

-- ---------------------------------------------------------------------
-- PRODUCTOS con costo documentado (remitos Quantum del 25/09/2026)
-- fracciones_por_unidad y rinde_sesiones quedan NULL a propósito:
-- sin ese dato el sistema muestra "margen: sin dato", nunca un número
-- inventado.
-- ---------------------------------------------------------------------
INSERT INTO productos (nombre, laboratorio, codigo_barras, tipo, unidad_compra, precio_venta) VALUES
  ('Hidrosomas - Crema Gel Humectante', 'Lidherma','7798177224666','reventa','pote 320g', 25000),
  ('ADN Polimerizado - Gel Hidratante', 'Lidherma','7798177224697','reventa','pote 320g', NULL),
  ('Mousse de Avena - Máscara',         'Lidherma','7798177221108','reventa','pote 300g', NULL),
  ('Leche de Limpieza con Siliconas',   'Icono',   '7798199010391','insumo_cabina','bidón 1kg', NULL),
  ('Gel Espuma Vinoterapia',            'Icono',   '7798199010476','insumo_cabina','bidón 1kg', NULL),
  ('Esponja Vegetal Facial',            'Accesorios','7794440008018','descartable','pack 2u', NULL),
  ('Aguja Dermapen Nano',               'Dermapen', NULL,           'descartable','unidad', NULL);


-- ---------------------------------------------------------------------
-- CATÁLOGO
-- ---------------------------------------------------------------------
INSERT INTO tratamientos (nombre, categoria) VALUES
  -- Faciales
  ('Facial estándar',             'facial'),
  ('Limpieza de cutis',           'facial'),
  ('Peeling',                     'facial'),
  ('Yellow Peel',                 'facial'),
  ('Peeling triple Oro',          'facial'),
  ('Mesopeeling',                 'facial'),
  ('Mesoterapia facial',          'facial'),
  ('Extracciones',                'facial'),
  ('Dermapen',                    'facial'),
  ('Dermapen plus',               'facial'),
  ('Dermapen premium',            'facial'),
  ('Dermapen colágeno',           'facial'),
  ('Hydrafacial',                 'facial'),
  ('Morpheus facial',             'facial'),
  ('Morpheus facial (sin frente)','facial'),
  ('Mio Up x1',                   'facial'),
  ('Mio Up x2',                   'facial'),
  ('Mio Up x3',                   'facial'),
  ('Hollywood peel',              'facial'),
  ('Indiba facial',               'facial'),
  -- Corporales
  ('Criolipólisis (1 zona)',      'corporal'),
  ('Criolipólisis (2 zonas)',     'corporal'),
  ('Liposonix',                   'corporal'),
  ('Morpheus corporal',           'corporal'),
  ('Indiba corporal',             'corporal'),
  ('Luz pulsada',                 'corporal'),
  ('Luz pulsada x2',              'corporal'),
  ('Trusculpt x1',                'corporal'),
  ('Trusculpt x2',                'corporal'),
  ('Presoterapia',                'corporal'),
  -- Combos
  ('Crio + Bota',                 'combo'),
  ('Crio x2 + Bota',              'combo'),
  ('Facial + corporal',           'combo'),
  -- Estética externa
  ('Tinte de ceja',               'estetica_externa'),
  ('Lifting de pestañas',         'estetica_externa'),
  -- Capilar y masajes
  ('Mesoterapia capilar',         'capilar'),
  ('Drenaje manual',              'masajes'),
  -- Estefanía
  ('Plasma facial',               'plasma'),
  ('Plasma capilar',              'plasma'),
  ('Remoción de tatuajes',        'tatuajes');

UPDATE tratamientos
   SET precio_variable = true, precio_min = 70000, precio_max = 85000
 WHERE nombre = 'Liposonix';

-- Sin rango: se presupuesta según el tamaño del tatuaje.
UPDATE tratamientos
   SET precio_variable = true
 WHERE nombre = 'Remoción de tatuajes';

-- ---------------------------------------------------------------------
-- PRECIOS vigentes desde 01/10/2026
-- Liposonix no lleva precio único: se cobra entre 70.000 y 85.000.
-- ---------------------------------------------------------------------
INSERT INTO precios_tratamiento (tratamiento_id, precio, vigente_desde)
SELECT t.id, v.precio, DATE '2026-10-01'
FROM tratamientos t
JOIN (VALUES
  ('Facial estándar',              42000),
  ('Limpieza de cutis',            39000),
  ('Peeling',                      45000),
  ('Yellow Peel',                  49000),
  ('Peeling triple Oro',           49000),
  ('Mesopeeling',                  59000),
  ('Mesoterapia facial',           52000),
  ('Extracciones',                 38000),
  ('Dermapen',                     50000),
  ('Dermapen plus',                55000),
  ('Dermapen premium',             59000),
  ('Dermapen colágeno',            52000),
  ('Hydrafacial',                  59000),
  ('Morpheus facial',              89000),
  ('Morpheus facial (sin frente)', 79000),
  ('Mio Up x1',                    22000),
  ('Mio Up x2',                    33000),
  ('Mio Up x3',                    40000),
  ('Hollywood peel',               70000),
  ('Indiba facial',                69000),
  ('Criolipólisis (1 zona)',       39000),
  ('Criolipólisis (2 zonas)',      49000),
  ('Morpheus corporal',            95000),
  ('Indiba corporal',              59000),
  ('Luz pulsada',                  89000),
  ('Luz pulsada x2',               95000),
  ('Trusculpt x1',                 69000),
  ('Trusculpt x2',                 75000),
  ('Presoterapia',                 30000),
  ('Crio + Bota',                  45000),
  ('Crio x2 + Bota',               55000),
  ('Facial + corporal',            89000),
  ('Tinte de ceja',                18000),
  ('Lifting de pestañas',          22000),
  ('Mesoterapia capilar',          30000),
  ('Drenaje manual',               40000),
  ('Plasma facial',                55000),
  ('Plasma capilar',               50000)
) AS v(nombre, precio) ON v.nombre = t.nombre;

-- ---------------------------------------------------------------------
-- COMISIONES DE YAEL — por tratamiento
-- ---------------------------------------------------------------------

-- Porcentajes
INSERT INTO reglas_comision (profesional_id, tratamiento_id, tipo, valor, vigente_desde)
SELECT p.id, t.id, 'porcentaje'::tipo_comision, v.pct, DATE '2026-10-01'
FROM profesionales p
CROSS JOIN (VALUES
  ('Facial estándar',              25),
  ('Limpieza de cutis',            25),
  ('Peeling',                      25),
  ('Yellow Peel',                  25),
  ('Peeling triple Oro',           25),
  ('Mesopeeling',                  25),
  ('Mesoterapia facial',           25),
  ('Extracciones',                 25),
  ('Dermapen',                     25),
  ('Dermapen plus',                25),   -- ASUMIDO: no venía en la lista
  ('Dermapen premium',             25),
  ('Dermapen colágeno',            25),
  ('Hydrafacial',                  25),
  ('Morpheus facial',              25),
  ('Morpheus facial (sin frente)', 25),
  ('Mio Up x1',                    25),
  ('Mio Up x2',                    25),
  ('Mio Up x3',                    25),
  ('Criolipólisis (1 zona)',       30),
  ('Criolipólisis (2 zonas)',      30),
  ('Liposonix',                    30),
  ('Morpheus corporal',            30),
  ('Indiba corporal',              30),
  ('Luz pulsada',                  30),
  ('Luz pulsada x2',               30),
  ('Crio + Bota',                  30),
  ('Crio x2 + Bota',               30),
  ('Facial + corporal',            30),
  ('Hollywood peel',               30),   -- excepción: facial al 30%
  ('Trusculpt x1',                 30),   -- era $10.000 fijo
  ('Trusculpt x2',                 30),   -- era $15.500 fijo
  ('Presoterapia',                 30),
  ('Tinte de ceja',                40),   -- histórico: los hacía Yael
  ('Lifting de pestañas',          40)    -- antes de la profesional externa
) AS v(nombre, pct)
JOIN tratamientos t ON t.nombre = v.nombre
WHERE p.nombre = 'Yael Juárez';

-- Monto fijo. Único que queda: $20.000 sobre $69.000 = 29%.
INSERT INTO reglas_comision (profesional_id, tratamiento_id, tipo, valor, vigente_desde)
SELECT p.id, t.id, 'monto_fijo'::tipo_comision, 20000, DATE '2026-10-01'
FROM profesionales p
JOIN tratamientos t ON t.nombre = 'Indiba facial'
WHERE p.nombre = 'Yael Juárez';

-- ---------------------------------------------------------------------
-- SILVIA — no cobra comisión. Lo que hace queda entero para MEK.
-- Una regla por categoría: cualquier tratamiento nuevo que haga Silvia
-- queda cubierto sin tener que cargarlo de a uno.
-- ---------------------------------------------------------------------
INSERT INTO reglas_comision (profesional_id, categoria, tipo, valor, vigente_desde)
SELECT p.id, c.categoria, 'porcentaje'::tipo_comision, 0, DATE '2026-10-01'
FROM profesionales p
CROSS JOIN (SELECT DISTINCT categoria FROM tratamientos) c
WHERE p.nombre = 'Silvia Orsi';

-- ---------------------------------------------------------------------
-- PROFESIONAL EXTERNA de lifting, perfilado y uñas.
-- Cobra ella y deja el 30%: acá se guarda el 70% que se lleva.
-- Tinte de ceja y lifting quedan cargados para los DOS: si los hace
-- Yael va su 40%, si los hace la externa va su 70%. El profesional
-- elegido en la venta decide cuál se aplica.
-- ---------------------------------------------------------------------
INSERT INTO reglas_comision (profesional_id, tratamiento_id, tipo, valor, vigente_desde)
SELECT p.id, t.id, 'porcentaje'::tipo_comision, 70, DATE '2026-10-01'
FROM profesionales p
JOIN tratamientos t ON t.nombre IN ('Tinte de ceja', 'Lifting de pestañas')
WHERE p.nombre = 'Lifting / perfilado / uñas';

-- ---------------------------------------------------------------------
-- ESTEFANÍA — se lleva el 50%. Cobra MEK y le debe su parte.
-- ---------------------------------------------------------------------
INSERT INTO reglas_comision (profesional_id, tratamiento_id, tipo, valor, vigente_desde)
SELECT p.id, t.id, 'porcentaje'::tipo_comision, 50, DATE '2026-10-01'
FROM profesionales p
JOIN tratamientos t ON t.nombre IN ('Plasma facial', 'Plasma capilar')
WHERE p.nombre = 'Estefanía';

-- Remoción de tatuajes: Estefanía se lleva el 40%, queda el 60% para MEK.
INSERT INTO reglas_comision (profesional_id, tratamiento_id, tipo, valor, vigente_desde)
SELECT p.id, t.id, 'porcentaje'::tipo_comision, 40, DATE '2026-10-01'
FROM profesionales p
JOIN tratamientos t ON t.nombre = 'Remoción de tatuajes'
WHERE p.nombre = 'Estefanía';

-- ---------------------------------------------------------------------
-- NOTAS
--
-- "Facial" a $40.000 no se cargó como tratamiento aparte: es la misma
-- Facial estándar con otro activo. El precio se ajusta al cobrar y el
-- sistema guarda los dos valores, así que la variación queda medida en
-- vez de perderse.
--
-- Mesoterapia capilar y Drenaje manual los hace Silvia: sin comisión,
-- quedan enteros para MEK.
-- ---------------------------------------------------------------------

-- Control: pares tratamiento/profesional sin comisión resuelta.
-- Busca primero la regla del tratamiento, después la de la categoría.
-- Si no hay ninguna, el par aparece acá y la app avisa al cobrar en
-- vez de asumir cero.
DROP VIEW IF EXISTS v_sin_comision;
CREATE VIEW v_sin_comision AS
SELECT t.nombre AS tratamiento, t.categoria, p.nombre AS profesional
FROM tratamientos t
CROSS JOIN profesionales p
WHERE t.activo AND p.activo AND t.categoria <> 'cabina'
  AND NOT EXISTS (
    SELECT 1 FROM reglas_comision r
    WHERE r.profesional_id = p.id
      AND (r.tratamiento_id = t.id OR r.categoria = t.categoria))
ORDER BY p.nombre, t.nombre;
