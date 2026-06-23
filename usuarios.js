const axios = require('axios');
const bcrypt = require('bcryptjs');
const { logger } = require('./logger');

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

let usuariosEnCache = [];
let ultimaCarga = null;

/**
 * Detecta si un valor de password almacenado ya es un hash bcrypt.
 * Los hashes bcrypt siempre empiezan con $2a$, $2b$ o $2y$.
 */
function esHashBcrypt(valor) {
  return typeof valor === 'string' && /^\$2[aby]\$\d{2}\$/.test(valor);
}

function parseCsv(texto) {
  const lineas = texto.split('\n');
  const filas = [];
  for (let i = 1; i < lineas.length; i++) {
    const line = lineas[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    const partes = [];
    let cur = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) {
        partes.push(cur.trim().replace(/^"|"$/g, ''));
        cur = '';
      } else cur += ch;
    }
    partes.push(cur.trim().replace(/^"|"$/g, ''));
    filas.push(partes);
  }
  return filas;
}

function filasAUsuarios(filas) {
  return filas
    .filter(p => p.length >= 2 && p[0])
    .map(p => ({
      usuario: String(p[0]).trim(),
      credencial: p[1] ? String(p[1]) : '',
      esHash: esHashBcrypt(p[1]),
      activo: p[2] ? String(p[2]).toLowerCase() === 'si' : true
    }));
}

async function cargarUsuarios() {
  const sheetGid = process.env.GOOGLE_SHEET_GID || '0';
  const sheetName = process.env.GOOGLE_SHEET_NAME || 'Usuarios';
  const publishedId = process.env.GOOGLE_PUBLISHED_ID;

  if (!GOOGLE_API_KEY && !publishedId) {
    logger.warn('No se encontró configuración de Google Sheets. Define GOOGLE_SHEET_ID + GOOGLE_API_KEY o GOOGLE_PUBLISHED_ID en .env.');
    usuariosEnCache = [];
    return;
  }

  // 1) Google Sheets API (recomendado: respeta permisos, no requiere publicar la hoja)
  if (GOOGLE_API_KEY && sheetName && GOOGLE_SHEET_ID) {
    try {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/${encodeURIComponent(sheetName)}?key=${GOOGLE_API_KEY}`;
      const resp = await axios.get(url, { timeout: 5000 });
      const values = resp.data.values || [];
      const usuarios = filasAUsuarios(values);
      if (usuarios.length > 0) {
        usuariosEnCache = usuarios;
        ultimaCarga = new Date();
        logger.info(`Usuarios cargados desde Google Sheets API: ${usuarios.length}`);
        avisarSiHayTextoPlano(usuarios);
        return;
      }
      logger.warn('La hoja de usuarios (API) está vacía.');
    } catch (error) {
      logger.warn(`API de Google Sheets no disponible, intentando alternativa: ${error.message}`);
    }
  }

  // 2) Published CSV (fallback)
  if (publishedId) {
    try {
      const pubCsv = `https://docs.google.com/spreadsheets/d/e/${publishedId}/pub?output=csv&gid=${sheetGid}`;
      const resp = await axios.get(pubCsv, { timeout: 5000 });
      const usuarios = filasAUsuarios(parseCsv(resp.data));
      usuariosEnCache = usuarios;
      ultimaCarga = new Date();
      logger.info(`Usuarios cargados desde CSV publicado: ${usuarios.length}`);
      avisarSiHayTextoPlano(usuarios);
      return;
    } catch (error) {
      logger.error(`No se pudo cargar el CSV publicado: ${error.message}`);
    }
  }

  logger.error('No se pudo cargar ninguna fuente de usuarios. Autenticación deshabilitada.');
  usuariosEnCache = [];
}

function avisarSiHayTextoPlano(usuarios) {
  const enTextoPlano = usuarios.filter(u => !u.esHash).length;
  if (enTextoPlano > 0) {
    logger.warn(
      `⚠️  SEGURIDAD: ${enTextoPlano} de ${usuarios.length} usuarios tienen contraseña en TEXTO PLANO en la hoja de Google. ` +
      `Se recomienda migrar a hashes bcrypt cuanto antes. Usa la utilidad hash-password.js para generarlos.`
    );
  }
}

/**
 * Verifica credenciales. Soporta tanto hashes bcrypt como texto plano (legado),
 * de forma transparente, hasta que termines de migrar la hoja.
 */
async function verificarCredenciales(usuarioIngresado, passwordIngresado) {
  const usuarioNorm = String(usuarioIngresado || '').trim().toLowerCase();
  const encontrado = usuariosEnCache.find(
    u => u.usuario.trim().toLowerCase() === usuarioNorm && u.activo
  );

  if (!encontrado) return null;

  let valido = false;
  if (encontrado.esHash) {
    valido = await bcrypt.compare(passwordIngresado, encontrado.credencial);
  } else {
    // Comparación en texto plano (legado) — migrar pronto
    valido = encontrado.credencial.trim() === String(passwordIngresado).trim();
  }

  return valido ? encontrado : null;
}

function getEstadoUsuarios() {
  return {
    total: usuariosEnCache.length,
    ultimaCarga,
    enTextoPlano: usuariosEnCache.filter(u => !u.esHash).length
  };
}

function getGoogleSheetsStatus() {
  return {
    apiConfigured: Boolean(GOOGLE_API_KEY && GOOGLE_SHEET_ID),
    publishedCsvConfigured: Boolean(process.env.GOOGLE_PUBLISHED_ID),
    sheetName: process.env.GOOGLE_SHEET_NAME || 'Usuarios',
    sheetGid: process.env.GOOGLE_SHEET_GID || '0'
  };
}

module.exports = {
  cargarUsuarios,
  verificarCredenciales,
  getEstadoUsuarios,
  getGoogleSheetsStatus,
  esHashBcrypt
};
