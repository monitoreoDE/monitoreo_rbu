const express = require('express');
const cors = require('cors');
const oracledb = require('oracledb');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { logger, auditarBusqueda, auditarLogin, auditarExportacion } = require('./logger');
const { cargarUsuarios, verificarCredenciales, getEstadoUsuarios, getGoogleSheetsStatus } = require('./usuarios');
const { generarExcel, generarPdf, ETIQUETAS_CAMPOS } = require('./exportar');

// ── Validación de configuración crítica al arrancar ──────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
const PLACEHOLDERS_PROHIBIDOS = ['tu_secreto_muy_seguro_cambiar_en_produccion_2026', 'change_me', 'secret'];

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('✖ JWT_SECRET no está definido o es demasiado corto (mínimo 32 caracteres). Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
if (PLACEHOLDERS_PROHIBIDOS.includes(JWT_SECRET)) {
  console.error('✖ JWT_SECRET sigue siendo un valor de ejemplo. Cámbialo antes de arrancar en producción.');
  process.exit(1);
}

const REQUIRED_DB_ENV = ['DB_USER', 'DB_PASSWORD'];
const ORACLE_CONN_STRING = process.env.ORACLE_CONNECTION_STRING;
const dbEnvSet = Boolean(process.env.DB_USER || process.env.DB_PASSWORD || process.env.DB_HOST || process.env.DB_PORT || process.env.DB_SERVICE || ORACLE_CONN_STRING);
const DB_CONFIGURED = Boolean(process.env.DB_USER && process.env.DB_PASSWORD && (ORACLE_CONN_STRING || (process.env.DB_HOST && process.env.DB_PORT && process.env.DB_SERVICE)));
if (dbEnvSet && !DB_CONFIGURED) {
  const faltantes = ['DB_USER', 'DB_PASSWORD']
    .filter(k => !process.env[k])
    .concat(!ORACLE_CONN_STRING && (!process.env.DB_HOST || !process.env.DB_PORT || !process.env.DB_SERVICE) ? ['DB_HOST', 'DB_PORT', 'DB_SERVICE'] : []);
  console.warn(`⚠ Configuración de la base de datos incompleta. Faltan: ${faltantes.join(', ')}. El servidor arrancará en modo solo login.`);
}

const app = express();
app.set('trust proxy', 1);

// ── Seguridad de cabeceras HTTP ───────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false // la UI es estática simple; ajustar si se sirve contenido externo
}));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : true,
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

const staticRoot = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : __dirname;
app.use(express.static(staticRoot));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ── Rate limiting ──────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.' }
});

const busquedaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas búsquedas en poco tiempo. Espera unos segundos.' }
});

const exportLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas exportaciones en poco tiempo. Intenta más tarde.' }
});

app.use(express.static(__dirname + '/public'));

// ── Configuración Oracle ───────────────────────────────────────────────────
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionString: ORACLE_CONN_STRING || `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_SERVICE}`
};

let pool;

async function initializePool() {
  pool = await oracledb.createPool({
    ...dbConfig,
    poolMin: 2,
    poolMax: 10,
    poolIncrement: 1,
    poolTimeout: 60
  });
  logger.info('Pool de conexiones Oracle inicializado');
}

// ── Constantes de dominio ───────────────────────────────────────────────────
const TABLA = 'EQ_DIR_EJE.STA_BASE_ESTADISTICA_DIR_EJE_PRIORIZACION_VISITAS_PADRON_ACTUAL_HOJA_01';
const CAMPOS_VALIDOS = ['VC_DNI', 'VC_DEPARTAMENTO', 'VC_PATERNO', 'VC_MATERNO', 'VC_NOMBRE'];
const CAMPOS_RESULTADOS = [
  'VC_DNI', 'VC_CODIGO_UBIGEO', 'VC_DEPARTAMENTO', 'VC_PROVINCIA', 'VC_DISTRITO',
  'VC_CCPP', 'VC_SECTOR', 'VC_DIRECCION_P65', 'VC_DIRECCION_DJ', 'VC_DIRECCION_SISFOH',
  'VC_PATERNO', 'VC_MATERNO', 'VC_NOMBRE', 'VC_FECHA_NACIMIENTO', 'NM_EDAD',
  'VC_RANGO_EDAD', 'VC_SEXO', 'VC_TELEFONO_TAYTA', 'VC_CONTACTO', 'VC_FECHA_INGRESO',
  'VC_FECHA_REINGRESO', 'VC_FECHA_ULTIMA_VISITA', 'VC_FECHA_SINCRONIZACION'
];
const MAX_RESULTADOS_POR_PAGINA = 50;
const MAX_RESULTADOS_EXPORTACION = 5000;

// ── Middleware de autenticación ─────────────────────────────────────────────
function verificarToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token no proporcionado' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.usuario = decoded.usuario;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function manejarErroresValidacion(req, res, next) {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: errores.array() });
  }
  next();
}

function obtenerIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
}

// ── Construcción segura de consultas (paginación + parámetros nombrados) ──
function construirQueryBusqueda(whereClause, offset, limit) {
  return `
    SELECT ${CAMPOS_RESULTADOS.join(', ')} FROM ${TABLA}
    WHERE ${whereClause}
    ORDER BY VC_DNI
    OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY
  `;
}

function construirQueryConteo(whereClause) {
  return `SELECT COUNT(*) AS TOTAL FROM ${TABLA} WHERE ${whereClause}`;
}

function normalizarBusquedaTexto(texto) {
  return String(texto || '').trim().replace(/\s+/g, ' ').slice(0, 100);
}

function construirCondicionBusqueda(campo, valor) {
  const texto = normalizarBusquedaTexto(valor);
  if (!texto) return null;

  if (campo === 'VC_DNI') {
    if (/^\d{8}$/.test(texto)) {
      return { clause: `${campo} = :criterio`, bind: { criterio: texto } };
    }
    return { clause: `${campo} LIKE :criterio`, bind: { criterio: `${texto}%` } };
  }

  const tokens = texto.split(' ');
  const bind = {};
  const clauses = tokens.map((token, index) => {
    const key = `criterio${index}`;
    bind[key] = `${token}%`;
    return `UPPER(${campo}) LIKE UPPER(:${key})`;
  });

  return {
    clause: clauses.join(' AND '),
    bind
  };
}

function construirCondicionLista(campo, lista, parametroBase) {
  const valores = lista.map(v => normalizarBusquedaTexto(v)).filter(Boolean);
  if (valores.length === 0) return null;

  const bind = {};
  if (campo === 'VC_DNI') {
    const placeholders = valores.map((valor, i) => {
      const key = `${parametroBase}${i}`;
      bind[key] = valor;
      return `:${key}`;
    });
    return { clause: `${campo} IN (${placeholders.join(', ')})`, bind };
  }

  const clauses = valores.map((valor, valueIndex) => {
    const tokens = valor.split(' ');
    const subClauses = tokens.map((token, tokenIndex) => {
      const key = `${parametroBase}${valueIndex}_${tokenIndex}`;
      bind[key] = `${token}%`;
      return `UPPER(${campo}) LIKE UPPER(:${key})`;
    });
    return `(${subClauses.join(' AND ')})`;
  });

  return {
    clause: clauses.join(' OR '),
    bind
  };
}

async function ejecutarBusquedaPaginada(whereClause, bindParams, pagina, porPagina) {
  let connection;
  try {
    connection = await pool.getConnection();

    const offset = (pagina - 1) * porPagina;

    const queryConteo = construirQueryConteo(whereClause);
    const resultConteo = await connection.execute(queryConteo, bindParams, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const total = resultConteo.rows[0].TOTAL;

    const queryDatos = construirQueryBusqueda(whereClause, offset, porPagina);
    const bindParamsConPaginacion = { ...bindParams, offset, limit: porPagina };
    const resultDatos = await connection.execute(queryDatos, bindParamsConPaginacion, { outFormat: oracledb.OUT_FORMAT_OBJECT });

    return { total, datos: resultDatos.rows };
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { logger.error(`Error al cerrar conexión: ${e.message}`); }
    }
  }
}

async function ejecutarBusquedaCompleta(whereClause, bindParams, max) {
  let connection;
  try {
    connection = await pool.getConnection();
    const query = `
      SELECT ${CAMPOS_RESULTADOS.join(', ')} FROM ${TABLA}
      WHERE ${whereClause}
      ORDER BY VC_DNI
      FETCH FIRST :maxRows ROWS ONLY
    `;
    const result = await connection.execute(query, { ...bindParams, maxRows: max }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    return result.rows;
  } finally {
    if (connection) {
      try { await connection.close(); } catch (e) { logger.error(`Error al cerrar conexión: ${e.message}`); }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// RUTAS
// ════════════════════════════════════════════════════════════════════════

app.post('/api/login',
  loginLimiter,
  [
    body('usuario').trim().notEmpty().withMessage('Usuario requerido').isLength({ max: 100 }),
    body('password').notEmpty().withMessage('Contraseña requerida').isLength({ max: 200 })
  ],
  manejarErroresValidacion,
  async (req, res) => {
    const usuarioIngresado = req.body.usuario;
    const passwordIngresado = req.body.password;
    const ip = obtenerIp(req);

    const estadoUsuarios = getEstadoUsuarios();
    if (estadoUsuarios.total === 0) {
      logger.warn('Intento de login sin usuarios cargados desde Google Sheets');
      return res.status(503).json({ error: 'No hay usuarios cargados. Revisa la configuración de Google Sheets.' });
    }

    try {
      const usuarioValido = await verificarCredenciales(usuarioIngresado, passwordIngresado);

      if (!usuarioValido) {
        auditarLogin({ usuario: usuarioIngresado, ip, exito: false, motivo: 'credenciales_invalidas' });
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      }

      const token = jwt.sign({ usuario: usuarioValido.usuario }, JWT_SECRET, { expiresIn: '8h' });

      auditarLogin({ usuario: usuarioValido.usuario, ip, exito: true });
      logger.info(`Login exitoso: ${usuarioValido.usuario} desde ${ip}`);

      res.json({ success: true, token, mensaje: `Bienvenido ${usuarioValido.usuario}` });
    } catch (error) {
      logger.error(`Error en login: ${error.message}`);
      res.status(500).json({ error: 'Error interno al procesar el inicio de sesión' });
    }
  }
);

app.post('/api/logout', (req, res) => {
  res.json({ success: true, mensaje: 'Sesión cerrada' });
});

app.get('/api/test-conexion', (req, res) => {
  const estado = getEstadoUsuarios();
  const googleStatus = getGoogleSheetsStatus();
  res.json({
    success: true,
    mensaje: 'Servidor disponible',
    usuariosCargados: estado.total,
    googleSheets: googleStatus
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    uptime: process.uptime(),
    env: process.env.NODE_ENV || 'production',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/me', verificarToken, (req, res) => {
  res.json({ usuario: req.usuario });
});

// Búsqueda simple (paginada)
app.post('/api/buscar',
  verificarToken,
  busquedaLimiter,
  [
    body('criterio').trim().notEmpty().withMessage('Criterio requerido').isLength({ max: 100 }),
    body('campo').trim().notEmpty().isIn(CAMPOS_VALIDOS).withMessage('Campo inválido'),
    body('pagina').optional().isInt({ min: 1 }).toInt(),
    body('porPagina').optional().isInt({ min: 1, max: MAX_RESULTADOS_POR_PAGINA }).toInt()
  ],
  manejarErroresValidacion,
  async (req, res) => {
    const { criterio, campo } = req.body;
    const pagina = req.body.pagina || 1;
    const porPagina = req.body.porPagina || 25;
    const ip = obtenerIp(req);

    try {
      if (!pool) {
        return res.status(503).json({ error: 'Servicio de búsqueda no disponible' });
      }
      const condicion = construirCondicionBusqueda(campo, criterio);
      if (!condicion) {
        return res.status(400).json({ error: 'Criterio inválido' });
      }
      const { total, datos } = await ejecutarBusquedaPaginada(condicion.clause, condicion.bind, pagina, porPagina);

      auditarBusqueda({ usuario: req.usuario, ip, tipo: 'simple', criterios: { campo, criterio }, totalResultados: total });

      res.json({
        success: true,
        total,
        pagina,
        porPagina,
        totalPaginas: Math.ceil(total / porPagina),
        data: datos
      });
    } catch (error) {
      logger.error(`Error en búsqueda simple: ${error.message}`);
      res.status(500).json({ error: 'Error en la búsqueda', detalle: 'Contacta al administrador del sistema' });
    }
  }
);

// Búsqueda avanzada (paginada)
app.post('/api/buscar-avanzado',
  verificarToken,
  busquedaLimiter,
  [
    body('criterios').isObject().withMessage('Criterios debe ser un objeto'),
    body('pagina').optional().isInt({ min: 1 }).toInt(),
    body('porPagina').optional().isInt({ min: 1, max: MAX_RESULTADOS_POR_PAGINA }).toInt()
  ],
  manejarErroresValidacion,
  async (req, res) => {
    const { criterios } = req.body;
    const pagina = req.body.pagina || 1;
    const porPagina = req.body.porPagina || 25;
    const ip = obtenerIp(req);

    const whereClause = [];
    const bindParams = {};
    let idx = 1;

    for (const [campo, valor] of Object.entries(criterios)) {
      if (CAMPOS_VALIDOS.includes(campo) && valor && String(valor).trim()) {
        const condicion = construirCondicionBusqueda(campo, valor);
        if (condicion) {
          whereClause.push(condicion.clause);
          Object.assign(bindParams, condicion.bind);
        }
      }
    }

    if (whereClause.length === 0) {
      return res.status(400).json({ error: 'Ingresa al menos un criterio válido' });
    }

    try {
      const { total, datos } = await ejecutarBusquedaPaginada(whereClause.join(' AND '), bindParams, pagina, porPagina);

      auditarBusqueda({ usuario: req.usuario, ip, tipo: 'avanzada', criterios, totalResultados: total });

      res.json({
        success: true,
        total,
        pagina,
        porPagina,
        totalPaginas: Math.ceil(total / porPagina),
        data: datos
      });
    } catch (error) {
      logger.error(`Error en búsqueda avanzada: ${error.message}`);
      res.status(500).json({ error: 'Error en la búsqueda', detalle: 'Contacta al administrador del sistema' });
    }
  }
);

// Búsqueda múltiple (varios valores del mismo campo, ej: lista de DNIs)
app.post('/api/buscar-multiple',
  verificarToken,
  busquedaLimiter,
  [
    body('campo').trim().notEmpty().isIn(CAMPOS_VALIDOS).withMessage('Campo inválido'),
    body('valores').isArray({ min: 1, max: 200 }).withMessage('Valores debe ser un array de 1 a 200 elementos'),
    body('valores.*').trim().notEmpty().isLength({ max: 100 }),
    body('pagina').optional().isInt({ min: 1 }).toInt(),
    body('porPagina').optional().isInt({ min: 1, max: MAX_RESULTADOS_POR_PAGINA }).toInt()
  ],
  manejarErroresValidacion,
  async (req, res) => {
    const { campo } = req.body;
    const valores = req.body.valores.map(v => String(v).trim()).filter(Boolean).slice(0, 200);
    const pagina = req.body.pagina || 1;
    const porPagina = req.body.porPagina || 25;
    const ip = obtenerIp(req);

    if (valores.length === 0) {
      return res.status(400).json({ error: 'Ingresa al menos un valor para buscar' });
    }

    try {
      if (!pool) {
        return res.status(503).json({ error: 'Servicio de búsqueda no disponible' });
      }

      const condicion = construirCondicionLista(campo, valores, 'pm');
      if (!condicion) {
        return res.status(400).json({ error: 'Valores inválidos para la búsqueda múltiple' });
      }

      const { total, datos } = await ejecutarBusquedaPaginada(condicion.clause, condicion.bind, pagina, porPagina);

      auditarBusqueda({ usuario: req.usuario, ip, tipo: 'multiple', criterios: { campo, cantidad: valores.length }, totalResultados: total });

      res.json({
        success: true,
        total,
        pagina,
        porPagina,
        totalPaginas: Math.ceil(total / porPagina),
        data: datos
      });
    } catch (error) {
      logger.error(`Error en búsqueda múltiple: ${error.message}`);
      res.status(500).json({ error: 'Error en la búsqueda', detalle: 'Contacta al administrador del sistema' });
    }
  }
);

// Búsqueda múltiple avanzada (varios valores por campo, combinados con AND entre campos)
app.post('/api/buscar-multiple-avanzado',
  verificarToken,
  busquedaLimiter,
  [
    body('criterios').isObject().withMessage('Criterios debe ser un objeto'),
    body('pagina').optional().isInt({ min: 1 }).toInt(),
    body('porPagina').optional().isInt({ min: 1, max: MAX_RESULTADOS_POR_PAGINA }).toInt()
  ],
  manejarErroresValidacion,
  async (req, res) => {
    const { criterios } = req.body;
    const pagina = req.body.pagina || 1;
    const porPagina = req.body.porPagina || 25;
    const ip = obtenerIp(req);

    const wherePartes = [];
    const bindParams = {};
    let paramIdx = 0;

    for (const [campo, valoresRaw] of Object.entries(criterios)) {
      if (!CAMPOS_VALIDOS.includes(campo)) continue;
      // Normalizar: acepta string o array
      const lista = (Array.isArray(valoresRaw) ? valoresRaw : [valoresRaw])
        .map(v => String(v || '').trim())
        .filter(Boolean)
        .slice(0, 200);
      if (lista.length === 0) continue;

      const condicion = construirCondicionLista(campo, lista, `p${paramIdx}`);
      if (condicion) {
        wherePartes.push(condicion.clause);
        Object.assign(bindParams, condicion.bind);
        paramIdx += Object.keys(condicion.bind).length;
      }
    }

    if (wherePartes.length === 0) {
      return res.status(400).json({ error: 'Ingresa al menos un criterio válido' });
    }

    try {
      const { total, datos } = await ejecutarBusquedaPaginada(wherePartes.join(' AND '), bindParams, pagina, porPagina);

      auditarBusqueda({ usuario: req.usuario, ip, tipo: 'multiple-avanzada', criterios, totalResultados: total });

      res.json({
        success: true,
        total,
        pagina,
        porPagina,
        totalPaginas: Math.ceil(total / porPagina),
        data: datos
      });
    } catch (error) {
      logger.error(`Error en búsqueda múltiple avanzada: ${error.message}`);
      res.status(500).json({ error: 'Error en la búsqueda', detalle: 'Contacta al administrador del sistema' });
    }
  }
);

// ── Exportación ─────────────────────────────────────────────────────────────
async function resolverCriteriosExportacion(req) {
  if (req.body.tipo === 'simple') {
    const { campo, criterio } = req.body;
    if (!campo || !CAMPOS_VALIDOS.includes(campo) || !criterio) return null;
    return { whereClause: `UPPER(${campo}) LIKE UPPER('%' || :criterio || '%')`, bindParams: { criterio }, texto: `${ETIQUETAS_CAMPOS[campo] || campo}: ${criterio}` };
  }

  if (req.body.tipo === 'multiple-avanzada') {
    const { criterios } = req.body;
    if (!criterios || typeof criterios !== 'object') return null;
    const wherePartes = [];
    const bindParams = {};
    const textoPartes = [];
    let paramIdx = 0;
    for (const [campo, valoresRaw] of Object.entries(criterios)) {
      if (!CAMPOS_VALIDOS.includes(campo)) continue;
      const lista = (Array.isArray(valoresRaw) ? valoresRaw : [valoresRaw])
        .map(v => String(v || '').trim()).filter(Boolean).slice(0, 200);
      if (lista.length === 0) continue;
      if (lista.length === 1) {
        const key = `p${paramIdx++}`;
        bindParams[key] = lista[0].slice(0, 100);
        wherePartes.push(`UPPER(${campo}) LIKE UPPER('%' || :${key} || '%')`);
      } else {
        const placeholders = lista.map((v) => {
          const key = `p${paramIdx++}`;
          bindParams[key] = v.slice(0, 100);
          return `:${key}`;
        });
        wherePartes.push(`UPPER(${campo}) IN (${placeholders.map(p => `UPPER(${p})`).join(', ')})`);
      }
      textoPartes.push(`${ETIQUETAS_CAMPOS[campo] || campo}: ${lista.join(', ')}`);
    }
    if (wherePartes.length === 0) return null;
    return { whereClause: wherePartes.join(' AND '), bindParams, texto: textoPartes.join(' | ') };
  }

  if (req.body.tipo === 'multiple') {
    const { campo, valores } = req.body;
    if (!campo || !CAMPOS_VALIDOS.includes(campo) || !Array.isArray(valores) || valores.length === 0) return null;
    const bindParams = {};
    const placeholders = valores.slice(0, 200).map((v, i) => {
      const key = `v${i}`;
      bindParams[key] = String(v).trim();
      return `:${key}`;
    });
    const whereClause = `UPPER(${campo}) IN (${placeholders.map(p => `UPPER(${p})`).join(', ')})`;
    return { whereClause, bindParams, texto: `${ETIQUETAS_CAMPOS[campo] || campo}: ${valores.length} valores` };
  }

  if (req.body.tipo === 'avanzada') {
    const criterios = req.body.criterios || {};
    const whereClause = [];
    const bindParams = {};
    const textoPartes = [];
    let idx = 1;
    for (const [campo, valor] of Object.entries(criterios)) {
      if (CAMPOS_VALIDOS.includes(campo) && valor && String(valor).trim()) {
        const paramName = `param${idx}`;
        whereClause.push(`UPPER(${campo}) LIKE UPPER('%' || :${paramName} || '%')`);
        bindParams[paramName] = String(valor).trim().slice(0, 100);
        textoPartes.push(`${ETIQUETAS_CAMPOS[campo] || campo}: ${valor}`);
        idx++;
      }
    }
    if (whereClause.length === 0) return null;
    return { whereClause: whereClause.join(' AND '), bindParams, texto: textoPartes.join(', ') };
  }

  return null;
}

app.post('/api/exportar/excel',
  verificarToken,
  exportLimiter,
  [body('tipo').isIn(['simple', 'avanzada', 'multiple', 'multiple-avanzada'])],
  manejarErroresValidacion,
  async (req, res) => {
    const ip = obtenerIp(req);
    try {
      const resuelto = await resolverCriteriosExportacion(req);
      if (!resuelto) return res.status(400).json({ error: 'Criterios inválidos para exportar' });

      const datos = await ejecutarBusquedaCompleta(resuelto.whereClause, resuelto.bindParams, MAX_RESULTADOS_EXPORTACION);
      const buffer = await generarExcel(datos, req.usuario);

      auditarExportacion({ usuario: req.usuario, ip, formato: 'excel', totalRegistros: datos.length });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="resultados_rbu_${Date.now()}.xlsx"`);
      res.send(buffer);
    } catch (error) {
      logger.error(`Error en exportación Excel: ${error.message}`);
      res.status(500).json({ error: 'Error al generar el archivo Excel' });
    }
  }
);

app.post('/api/exportar/pdf',
  verificarToken,
  exportLimiter,
  [body('tipo').isIn(['simple', 'avanzada', 'multiple', 'multiple-avanzada'])],
  manejarErroresValidacion,
  async (req, res) => {
    const ip = obtenerIp(req);
    try {
      const resuelto = await resolverCriteriosExportacion(req);
      if (!resuelto) return res.status(400).json({ error: 'Criterios inválidos para exportar' });

      const datos = await ejecutarBusquedaCompleta(resuelto.whereClause, resuelto.bindParams, MAX_RESULTADOS_EXPORTACION);
      const buffer = await generarPdf(datos, req.usuario, resuelto.texto);

      auditarExportacion({ usuario: req.usuario, ip, formato: 'pdf', totalRegistros: datos.length });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="resultados_rbu_${Date.now()}.pdf"`);
      res.send(buffer);
    } catch (error) {
      logger.error(`Error en exportación PDF: ${error.message}`);
      res.status(500).json({ error: 'Error al generar el archivo PDF' });
    }
  }
);

app.post('/api/reload-users', verificarToken, async (req, res) => {
  try {
    await cargarUsuarios();
    res.json({ success: true, ...getEstadoUsuarios() });
  } catch (error) {
    res.status(500).json({ error: 'Error al recargar usuarios' });
  }
});

// Manejador genérico de errores no capturados en rutas
app.use((err, req, res, next) => {
  logger.error(`Error no manejado: ${err.stack || err.message}`);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── Arranque ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;

async function start() {
  if (DB_CONFIGURED) {
    await initializePool();
  } else {
    logger.warn('No hay configuración completa de Oracle. Las rutas de búsqueda y exportación estarán deshabilitadas.');
  }

  await cargarUsuarios();

  setInterval(async () => {
    logger.info('Recargando usuarios desde Google Sheets...');
    await cargarUsuarios();
  }, 5 * 60 * 1000);

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Servidor ejecutándose en http://localhost:${PORT}`);
    if (DB_CONFIGURED) logger.info(`Tabla: ${TABLA}`);
    else logger.warn('Servidor iniciado sin conexión a Oracle. Solo login y carga de usuarios funcionarán.');
  });
}

process.on('SIGINT', async () => {
  logger.info('Cerrando servidor...');
  if (pool) await pool.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Cerrando servidor (SIGTERM)...');
  if (pool) await pool.close();
  process.exit(0);
});

start().catch(err => {
  logger.error(`Error fatal al iniciar: ${err.message}`);
  process.exit(1);
});
