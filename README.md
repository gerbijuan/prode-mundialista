# El Prode Mundialista · paquete actualizado gratis

Este paquete está pensado para **actualizar la versión anterior que ya subiste a Firebase** sin perder datos y sin usar servicios de pago.

Arquitectura gratuita:

- **Firebase Hosting** para la web
- **Firebase Authentication** para login con Google
- **Cloud Firestore** para usuarios, apuestas y resultados
- **GitHub Actions** para sincronizar resultados cada hora
- **Google Apps Script + Gmail** para enviar los correos

## Qué cambia en esta versión

- nombre final: **El Prode Mundialista**
- branding con `jp_renegado`
- menú móvil fijo abajo a la izquierda
- secciones separadas: **Resumen / Apuestas / Clasificación / Fixture**
- bloque especial **Partidos de Argentina**
- **Fixture completo** separado del **Cuadro final**
- scoring nuevo:
  - **4** exacto
  - **2** signo
  - **1** si jugó y falló
  - **0** si no jugó
- Admin oculto salvo para **`gerbijuan@gmail.com`**
- el botón **Sembrar fixture** ya **no pisa resultados existentes** y además rellena `kickoffAtMs`

---

## Estructura

- `public/index.html` → web app actualizada
- `public/data/fixture-2026.json` → fixture base para seed automático del script
- `public/data/bracket-2026.json` → cuadro final visual
- `firebase.json` → Hosting + Firestore
- `firestore.rules` → reglas de seguridad
- `firestore.indexes.json` → índices
- `scripts/sync-results.mjs` → sync horario + ranking + emails
- `.github/workflows/sync-results.yml` → cron de GitHub Actions
- `apps-script/Code.gs` → envío de correos con tu Gmail
- `package.json` → dependencias del job

---

# A. ACTUALIZAR SI YA TENÍAS LA VERSIÓN ANTERIOR PUBLICADA

## 1. Haz copia local del proyecto anterior

Si ya tenías una carpeta local de la versión anterior, guarda una copia por si quieres volver atrás.

## 2. Sustituye tus archivos por los de este paquete

Puedes hacerlo de dos formas:

### Opción simple
Descomprime este ZIP en una carpeta nueva y trabaja desde ahí.

### Opción sobre tu carpeta existente
Copia y reemplaza estos archivos/carpetas en tu proyecto actual:

- `public/index.html`
- `public/data/fixture-2026.json`
- `public/data/bracket-2026.json`
- `firebase.json`
- `firestore.rules`
- `firestore.indexes.json`
- `package.json`
- `scripts/`
- `.github/workflows/`
- `apps-script/`

**No borres**:
- `.firebaserc`
- tu repo Git actual
- tus secretos en GitHub
- tus colecciones existentes de Firestore

## 3. Revisa tu `FIREBASE_CONFIG`

Este paquete vuelve a venir con placeholders. Si reemplazaste `public/index.html`, vuelve a pegar tu bloque real:

```js
const FIREBASE_CONFIG = {
  apiKey: 'TU_API_KEY',
  authDomain: 'TU_AUTH_DOMAIN',
  projectId: 'TU_PROJECT_ID',
  storageBucket: 'TU_STORAGE_BUCKET',
  messagingSenderId: 'TU_MESSAGING_SENDER_ID',
  appId: 'TU_APP_ID'
};
```

Si ya lo habías hecho en la versión anterior, simplemente copia ese bloque a este nuevo `index.html`.

## 4. Mantén el mismo proyecto Firebase

Este paquete está pensado para seguir usando el **mismo proyecto** que ya tenías. Asegúrate de que `.firebaserc` sigue apuntando al mismo `projectId`.

Ejemplo:

```json
{
  "projects": {
    "default": "tu-project-id"
  }
}
```

## 5. Despliega la actualización

Desde la **raíz del proyecto**:

```bash
firebase deploy --only hosting,firestore
```

Eso:
- actualiza la web publicada
- vuelve a publicar reglas/índices si cambiaron
- **no borra** tus colecciones existentes de Firestore

## 6. Haz una actualización segura del fixture ya existente

Después del deploy:

1. abre la web publicada
2. inicia sesión con **`gerbijuan@gmail.com`**
3. entra en **Admin**
4. pulsa **“Sembrar fixture 2026 en Firebase”** **una sola vez**

En esta versión el seed:
- añade `kickoffAtMs` si faltaba
- completa metadatos del fixture
- **no resetea resultados existentes**

Esto es importante sobre todo si tu versión anterior había sembrado partidos sin `kickoffAtMs`.

## 7. Comprueba que las apuestas siguen funcionando

Verifica con un usuario normal que:
- puede iniciar sesión
- puede apostar en partidos futuros
- no puede editar partidos ya empezados
- no ve la sección Admin

## 8. Actualiza GitHub para el sync horario

Si ya tenías el repo conectado a GitHub:

```bash
git add .
git commit -m "Actualiza Prode Mundialista"
git push
```

Eso actualizará:
- el workflow horario
- el script de sync
- la nueva lógica de puntuación 4/2/1/0

## 9. Actualiza Google Apps Script

Si ya tenías un proyecto Apps Script creado:

1. abre tu proyecto Apps Script existente
2. reemplaza el contenido de `Code.gs` por el nuevo `apps-script/Code.gs`
3. guarda
4. vuelve a desplegar la Web App como **nueva versión** o actualiza el deployment existente

Si mantienes la misma Web App URL, **no necesitas cambiar** el secreto `APPS_SCRIPT_WEBAPP_URL` en GitHub.

## 10. Lanza una prueba manual

En GitHub:
- **Actions**
- **Sync World Cup Results**
- **Run workflow**

Comprueba:
- que el job termina bien
- que `ranking/current` se actualiza
- que si hay cambio de resultado y había apuestas, salen correos desde Gmail

---

# B. DESPLIEGUE COMPLETO DESDE CERO (SI HICIERA FALTA)

## 1. Preparar Firebase

En Firebase Console, dentro del mismo proyecto o en uno nuevo, activa:

- **Authentication**
- **Cloud Firestore**
- **Hosting**

En **Authentication > Sign-in method**, habilita **Google**.

En **Authentication > Settings > Authorized domains**, añade:
- `localhost`
- tu dominio `*.web.app`
- tu dominio `*.firebaseapp.com`

## 2. Inicializar Firebase CLI

Hazlo desde la **raíz del proyecto**, no desde `public`.

```bash
npm install -g firebase-tools
firebase login
firebase init hosting
firebase init firestore
```

### Qué responder en `firebase init hosting`

- **Use an existing project**
- elige tu proyecto
- **public directory**: `public`
- **Configure as a single-page app**: `Yes`
- **Set up automatic builds and deploys with GitHub**: `No`
- si te pregunta por sobrescribir `index.html`, responde **No**

### Qué responder en `firebase init firestore`

- usa `firestore.rules`
- usa `firestore.indexes.json`
- si pregunta por sobrescribir, responde **No**

## 3. Desplegar

```bash
firebase deploy --only hosting,firestore
```

Obtendrás un dominio fijo gratis como:

- `https://tu-proyecto.web.app`
- `https://tu-proyecto.firebaseapp.com`

---

# C. GITHUB ACTIONS GRATIS

## 1. Recomendación importante

Para mantener GitHub Actions gratis de forma cómoda, usa **repo público**.

## 2. Secretos de GitHub necesarios

En tu repo:
**Settings > Secrets and variables > Actions**

Crea:

- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `FOOTBALL_DATA_API_KEY`
- `SITE_URL`
- `APPS_SCRIPT_WEBAPP_URL`
- `APPS_SCRIPT_SHARED_TOKEN`

## 3. API key de football-data.org

1. crea cuenta en football-data.org
2. copia tu API key
3. guárdala como `FOOTBALL_DATA_API_KEY`

## 4. Cuenta de servicio de Firebase

1. entra en **Google Cloud Console** del proyecto
2. crea una **Service Account** con permisos sobre Firestore
3. descarga el JSON
4. pega el JSON completo en `FIREBASE_SERVICE_ACCOUNT_JSON`

---

# D. APPS SCRIPT + GMAIL GRATIS

## 1. Crear o actualizar el proyecto de Apps Script

1. ve a Google Apps Script
2. crea un proyecto nuevo o abre el existente
3. pega `apps-script/Code.gs`

## 2. Guardar el token compartido

Edita la función `setSharedToken()` y reemplaza `REEMPLAZA_ESTE_TOKEN` por un token largo y secreto.

Ejecuta esa función una sola vez.

También puedes guardar manualmente una Script Property:
- clave: `PRODE_SHARED_TOKEN`
- valor: tu token

## 3. Probar envío con Gmail

Ejecuta `testMail()`.

Si te llega el correo, tu Gmail ya está listo para enviar.

## 4. Desplegar como Web App

1. **Deploy > New deployment**
2. tipo: **Web app**
3. **Execute as**: `Me`
4. **Who has access**: `Anyone`
5. despliega
6. copia la URL

Guarda esa URL en GitHub como:
- `APPS_SCRIPT_WEBAPP_URL`

Guarda también el mismo token como:
- `APPS_SCRIPT_SHARED_TOKEN`

---

# E. ORDEN RECOMENDADO PARA TU CASO CON LA VERSIÓN YA PUBLICADA

## Si ya tienes Firebase funcionando y sólo quieres actualizar

Haz esto en este orden:

```bash
# 1) sustituye archivos por los nuevos
# 2) desde la raíz del proyecto
firebase deploy --only hosting,firestore

# 3) sube también los cambios del workflow y script a GitHub
git add .
git commit -m "Actualiza Prode Mundialista"
git push
```

Luego:

1. abre la web publicada
2. entra con `gerbijuan@gmail.com`
3. pulsa **Sembrar fixture 2026 en Firebase** una vez
4. actualiza tu Apps Script con el nuevo `Code.gs`
5. ejecuta **Run workflow** en GitHub una vez para probar

---

# F. QUÉ NO TIENES QUE HACER

- no necesitas **Firebase Functions**
- no necesitas **Resend**
- no necesitas **dominio propio**
- no necesitas borrar Firestore ni volver a crear colecciones

---

# G. NOTAS IMPORTANTES

- Los datos de usuarios, apuestas y resultados se conservan mientras uses el mismo proyecto Firebase.
- El scoring nuevo se aplicará al recálculo de ranking en la web y en el sync horario.
- Si ya tenías resultados cargados, no los borres ni vuelvas a crear Firestore.
- El seed nuevo es seguro para actualizar partidos ya existentes.

---

# H. COMANDOS RÁPIDOS

## Actualizar despliegue web

```bash
firebase deploy --only hosting,firestore
```

## Actualizar GitHub Actions

```bash
git add .
git commit -m "Actualiza Prode Mundialista"
git push
```

## Instalar dependencias del script localmente

```bash
npm install
```

## Ejecutar sync local manual (opcional)

```bash
npm run sync:results
```

---

Si en cualquiera de los pasos te sale un prompt o un error concreto, pégalo tal cual y te digo exactamente qué contestar o qué corregir.
