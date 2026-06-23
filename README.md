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

## Requisitos

- Node.js 18+
- Oracle Instant Client o acceso al driver Oracle de Node.js
- Credenciales válidas de base de datos y Google Sheets

## Notas

- No subas `.env` al repositorio.
- `.gitignore` ya excluye `.env`, `node_modules/` y `logs/`.
- Si se usa Google Sheets API y da error 403, usa `GOOGLE_PUBLISHED_ID` para la hoja publicada en CSV.
