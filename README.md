# Motor de Búsqueda RBU

Este repositorio contiene una aplicación de búsqueda que se conecta a Oracle y usa Google Sheets para cargar usuarios.

## Archivos principales

- `index.html` - Página de login.
- `busqueda.html` - Interfaz de búsqueda e importación/exportación.
- `server.js` - API backend en Node.js/Express.
- `usuarios.js` - Carga de usuarios desde Google Sheets.
- `exportar.js` - Genera archivos Excel/PDF.
- `hash-password.js` - Utilidad para generar hashes bcrypt.
- `.env.example` - Plantilla de variables de entorno.

## Instalación

1. Copia `.env.example` a `.env`.
2. Llena los valores reales en `.env`.
3. Ejecuta:
   ```bash
   npm install
   ```

## Ejecución

1. Inicia el servidor:
   ```bash
   npm start
   ```
2. Abre en el navegador:
   ```
   http://localhost:3000/index.html
   ```

## Despliegue en GitHub Pages

GitHub Pages sirve solo archivos estáticos. El backend Node.js/Express no se ejecuta en GitHub Pages.
Para que la aplicación funcione desde GitHub Pages necesitas:

- desplegar el backend en un host que soporte Node.js (por ejemplo, Railway, Render, Vercel, Azure, un VPS, etc.)
- configurar la URL pública de la API en el frontend

Por ejemplo, si tu backend está en `https://mi-backend.example.com`, agrega antes del script principal:

```html
<script>
  window.API_BASE_URL = 'https://mi-backend.example.com/api';
</script>
```

## Despliegue en Railway / Render

1. Sube este repositorio o conecta tu repositorio a Railway/Render.
2. Asegúrate de que el servicio use `npm start` como comando de inicio. El `package.json` ya tiene:
   ```json
   "scripts": {
     "start": "node server.js"
   }
   ```
3. En las variables de entorno del servicio configura:
   - `DB_USER`
   - `DB_PASSWORD`
   - `DB_HOST` / `DB_PORT` / `DB_SERVICE`
   - o `ORACLE_CONNECTION_STRING` si tu proveedor te da una cadena de conexión Oracle completa.
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_API_KEY`
   - `GOOGLE_SHEET_NAME`
   - `GOOGLE_SHEET_GID`
   - `GOOGLE_PUBLISHED_ID` (opcional, si usas la hoja publicada en CSV)
   - `JWT_SECRET`
   - `ALLOWED_ORIGINS` (por ejemplo, `https://<tu-sitio>.github.io` o `https://<tu-backend>.onrender.com`)
4. Railway y Render proveen automáticamente `PORT`; `server.js` ya usa `process.env.PORT`.

### Verificación

- Revisa `/api/health` en tu backend desplegado. Debe devolver JSON con `success: true`.
- Revisa `/api/test-conexion` para validar que los usuarios de Google Sheets estén cargados.

### Nota importante

Railway y Render pueden no ejecutar Oracle localmente. Si usas Oracle, debes exponer la base de datos a internet o conectarte a través de una VPN / túnel admitido por el servicio.

Para el frontend estático en GitHub Pages, coloca la URL pública del backend en `window.API_BASE_URL`.

## Requisitos

- Node.js 18+
- Oracle Instant Client o acceso al driver Oracle de Node.js
- Credenciales válidas de base de datos y Google Sheets

## Notas

- No subas `.env` al repositorio.
- `.gitignore` ya excluye `.env`, `node_modules/` y `logs/`.
- Si se usa Google Sheets API y da error 403, usa `GOOGLE_PUBLISHED_ID` para la hoja publicada en CSV.
