# RÍO CLARO AI

**Autor:** Rebollar Cervantes Michael Gabriel  
**Problema:** la información de ventas, inventario, facturas y atención puede requerir búsquedas y revisiones manuales antes de decidir.  
**Objetivo:** demostrar cómo una aplicación web con análisis e IA puede organizar esos flujos sin sustituir la autorización ni el criterio de una persona.  
**Solución:** dashboard, reporte comercial sintético, inventario por sucursal, registro y revisión documental, seguimiento de reclamaciones y chat/dictado conectado opcionalmente a Microsoft Foundry.

Esta versión está preparada para validación local. Los productos, sucursales, importes, facturas, duplicados y actividades precargados son **datos sintéticos de demostración** y no provienen de sistemas corporativos. Se guardan en archivos JSON configurables; no hay integración con inventario ni facturación corporativos. El OCR es una integración opcional con Azure AI Document Intelligence y no se ha conectado ni validado con un recurso Azure. Toda sugerencia requiere revisión humana.

## Arquitectura

- Node.js 24 y JavaScript ES Modules.
- Express 5 sirve `public/` y centraliza las rutas en `server/app.js`.
- HTML, CSS y JavaScript nativos; iconos SVG locales y tipografía del sistema, sin recursos visuales externos.
- Microsoft Foundry con `@azure/ai-projects` 2.x y `DefaultAzureCredential`; el navegador solo llama al backend.
- Entra ID: Azure CLI (`az login`) para desarrollo local e identidad administrada en App Service. `AZURE_CLIENT_ID` selecciona una identidad administrada asignada por el usuario.
- Los datos y catálogos se conservan en archivos JSON configurables; la auditoría y las conversaciones de Foundry tienen sus propios archivos.
- `server/data/sales.js` crea el conjunto de ventas sintéticas y calcula las métricas; `server/services/document-intelligence.js` implementa extracción opcional sin guardar documentos.

## Servicios Azure previstos

| Servicio | Uso | Estado comprobable |
|---|---|---|
| Azure App Service | Hospedar Express y la interfaz estática | Preparación en código; no desplegado ni validado en una suscripción. |
| Microsoft Foundry | Agente existente `RioClaroAssistant` | Integración SDK lista para configurar; agente, RBAC y respuesta real pendientes de validar externamente. |
| Microsoft Entra ID | Validar access tokens y roles de la API | Verificador backend presente; inicio de sesión web todavía no implementado. |
| Azure AI Document Intelligence | OCR opcional para facturas de prueba | Adaptador real opcional; requiere endpoint, identidad y permiso `Cognitive Services User`; no validado con Azure. |
| Azure Key Vault | Carga opcional de configuración/secretos | Integración existente; no es obligatoria para iniciar sin configuración. |

No se han creado ni modificado recursos Azure. Las tablas de evaluación usan datos sintéticos y no están conectadas a sistemas de Distribuidora Río Claro.

## Estructura

```text
server.js
server/
  app.js
  data/store.js
  data/sales.js
  data/product-normalization.js
  security/
  services/foundry.js
  services/document-intelligence.js
  assistant-instructions.js
public/
  index.html
  favicon.svg
  styles.css
  app.js
  escape.js
  icons.js
tests/
  security.test.js
  sales.test.js
  invoice-workflow.test.js
  invoice-extraction.test.js
  complaints.test.js
  chat-voice.test.js
```

## Requisitos

- Windows 11 y PowerShell.
- Node.js 22 o superior; desarrollo y pruebas locales verificados con Node.js 24.
- npm.
- Opcional para IA local: Azure CLI y acceso al proyecto y al agente de Microsoft Foundry.

## Instalación y ejecución local

Desde PowerShell, en la carpeta del proyecto:

```powershell
npm install
Copy-Item .env.example .env
notepad .env
npm start
```

El servidor local escucha en `127.0.0.1:3000`. Abre `http://127.0.0.1:3000`. `npm start` permanece ejecutándose en esa consola; usa otra consola para validar:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-WebRequest http://127.0.0.1:3000/ | Select-Object -ExpandProperty StatusCode
npm test
```

La aplicación inicia sin configurar Azure ni Foundry. En ese estado, la interfaz permite explorar los datos de demostración y muestra la IA como pendiente; no inventa respuestas.

## Variables de entorno

`.env` está excluido de Git. Nunca coloques tokens, claves ni secretos en `.env.example`, el navegador, los logs o el repositorio.

| Variable | Uso |
|---|---|
| `PORT` | Puerto HTTP local; por defecto `3000`. |
| `CORS_ALLOWED_ORIGINS` | Orígenes web adicionales permitidos, separados por comas. Vacío es adecuado para servir la web desde el mismo origen. |
| `FOUNDRY_PROJECT_ENDPOINT` | Endpoint HTTPS del proyecto Foundry. Para este proyecto: `https://rioclaroia-resource.services.ai.azure.com/api/projects/rioclaroia`. |
| `FOUNDRY_AGENT_NAME` | Nombre del agente existente. El valor inicial es `RioClaroAssistant`. |
| `FOUNDRY_ENABLED` | Debe ser `true` para permitir solicitudes al agente. El valor inicial es `false`. |
| `FOUNDRY_SUSPENDED` | Interruptor de seguridad; `true` bloquea nuevas llamadas. |
| `FOUNDRY_TIMEOUT_MS` | Tiempo máximo de espera, de 1,000 a 120,000 ms; por defecto `20000`. |
| `AZURE_CLIENT_ID` | Opcional; solo para seleccionar una identidad administrada asignada por el usuario en Azure. |
| `DOCUMENT_INTELLIGENCE_ENDPOINT` | Endpoint HTTPS de Azure AI Document Intelligence; opcional. En App Service, la identidad administrada necesita `Cognitive Services User`. |
| `ALLOW_UNAUTHENTICATED_LOCAL_CHAT` | Debe ser `true` para permitir chat local sin Entra. Solo tiene efecto cuando `NODE_ENV` no es `production`; déjalo en `false` fuera del desarrollo local. |
| `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID`, `ENTRA_BRANCH_CLAIM` | Preparación de la API para validar access tokens y roles de Microsoft Entra. No habilitan por sí mismos un inicio de sesión web. |
| `KEY_VAULT_URL`, `KEY_VAULT_SECRET_NAMES` | Carga opcional de secretos `FOUNDRY_*` en Azure mediante identidad administrada. La configuración de Key Vault existente sigue disponible. |

### Autenticación de Foundry

La integración usa `@azure/ai-projects` 2.9.0 y `@azure/identity` con `DefaultAzureCredential`. El endpoint consumido es el **project endpoint** `https://rioclaroia-resource.services.ai.azure.com/api/projects/rioclaroia`; el SDK obtiene el cliente OpenAI compatible desde el proyecto y llama al agente existente `RioClaroAssistant` por nombre. No uses como `FOUNDRY_PROJECT_ENDPOINT` ni la ruta de agente `/agents/.../endpoint/protocols/openai/responses` ni el endpoint base `rioclaroia-resource.openai.azure.com/openai/v1`: son interfaces distintas y no son el endpoint de proyecto que requiere `AIProjectClient`.

En local:

1. Obtén el project endpoint desde **Microsoft Foundry → tu proyecto → Overview**. El formato esperado es `https://<recurso>.services.ai.azure.com/api/projects/<proyecto>`.
2. Confirma que el agente `RioClaroAssistant` existe en ese proyecto.
   La API Responses invoca el agente mediante `agent_reference` y no admite enviar `instructions` en la misma solicitud. Antes de usarlo, configura las instrucciones de sistema y las políticas de seguridad directamente en el agente de Foundry, usando como referencia el texto mantenido en `server/assistant-instructions.js`. El código también envía un contexto JSON con los registros actuales permitidos por el rol y la sucursal; el agente debe tratarlo como datos y nunca como instrucciones.
3. Inicia sesión con la cuenta autorizada en la suscripción correcta:

   ```powershell
   az login
   ```

4. Asigna al usuario de desarrollo el rol **Foundry User** en el recurso Foundry; configura el endpoint, nombre del agente y `FOUNDRY_ENABLED=true` en `.env`. `DefaultAzureCredential` puede usar Azure CLI, credenciales de desarrollo instaladas o variables de entorno de Entra; no se usa una clave API.
5. Si solo estás validando localmente sin Entra para la aplicación web, establece además `ALLOW_UNAUTHENTICATED_LOCAL_CHAT=true`. El servidor está ligado a loopback en modo no producción, y se siguen rechazando patrones de datos sensibles.
6. Reinicia `npm start` y usa **Verificar conexión** en la pantalla del asistente. Esta comprobación intenta leer el agente mediante el SDK; no genera una respuesta ni muestra credenciales.

En Azure App Service, habilita una identidad administrada y asígnale el rol mínimo **Foundry Agent Consumer** en el recurso Foundry para invocar agentes sin crearlos ni modificarlos. Configura `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_AGENT_NAME=RioClaroAssistant`, `FOUNDRY_ENABLED=true` y `FOUNDRY_SUSPENDED=false` en la configuración de aplicación; no guardes secretos. `DefaultAzureCredential` detecta la identidad administrada del host; usa `AZURE_CLIENT_ID` solo si es asignada por el usuario. No se crean recursos de Azure desde esta aplicación.

Referencias oficiales:

- [Microsoft Foundry SDK de JavaScript](https://learn.microsoft.com/en-us/javascript/api/overview/azure/ai-projects-readme?view=azure-node-latest)
- [Inicio rápido del SDK y agentes de Foundry](https://learn.microsoft.com/en-us/azure/foundry/quickstarts/get-started-code?tabs=javascript)
- [Roles RBAC de Microsoft Foundry](https://learn.microsoft.com/en-us/azure/foundry/concepts/rbac-foundry)

## Rutas

| Método | Ruta | Comportamiento |
|---|---|---|
| `GET` | `/` | Interfaz web servida desde `public/`. |
| `GET` | `/health` | Estado del servidor y booleanos de configuración de Foundry, sin secretos. |
| `GET` | `/api/health` | Alias compatible del estado. |
| `GET` | `/api/security/status` | Estado de autenticación, demo, Key Vault y banderas de IA sin credenciales. |
| `POST` | `/api/foundry/check` | Comprueba por separado que el agente configurado se puede consultar. Tiene límite de frecuencia. |
| `GET` | `/api/dashboard`, `/api/products`, `/api/invoices` | Datos de demostración etiquetados. |
| `GET` | `/api/sales` | Calcula indicadores por periodo, producto y sucursal usando únicamente ventas sintéticas. Ventas operativas no están conectadas. |
| `POST` | `/api/sales/summary` | Pide a Foundry una interpretación acotada del reporte sintético; no inventa cifras y requiere revisión humana. |
| `POST` | `/api/chat` | Envía texto escrito o transcrito y una instantánea acotada de inventario/facturas autorizados al agente existente `RioClaroAssistant`. Conserva el identificador de conversación, respeta el origen seleccionado, los roles y el alcance de sucursal; datos de práctica se identifican como no verificados. Vacío o más de 2,000 caracteres devuelve `422`; falta de configuración `503`; falla o timeout de Foundry `502` genérico. |
| `POST` | `/api/assistant` | Alias anterior de `/api/chat`. |
| `POST` | `/api/products`, `/api/invoices` | En desarrollo local acepta altas únicamente en datos `practice`; las escrituras `operational` y cualquier escritura en producción requieren identidad y rol Entra verificados. Las facturas quedan pendientes de revisión y no registran pagos. |
| `POST` | `/api/products/equivalences/confirm` | Confirmación administrativa explícita, con IDs y justificación, antes de agrupar candidatos de producto. |
| `POST` | `/api/invoices/product-match` | Recibe el nombre detectado y atributos opcionales para relacionar una línea de factura sin alterar importes, unidades o registros contables; una coincidencia incierta queda para revisión humana. |
| `POST` | `/api/invoices/extract` | Extrae campos de PDF/JPG/PNG de hasta 5 MB en memoria con Document Intelligence configurado. No conserva el archivo; el modo de evaluación pública lo bloquea. |
| `POST` | `/api/invoices/:invoiceId/review` | Registra una decisión y justificación humana; solo la confirmación autorizada genera el movimiento de inventario previsto. No ejecuta pagos. |
| `POST` | `/api/admin/ai-control`, `GET /api/admin/audit` | Control de seguridad y auditoría; requieren rol Administrator. |
| `GET`, `POST` | `/api/complaints` | Consulta por sucursal y estado, o registra una reclamación con sucursal, cliente, descripción, categoría y contacto opcional. |
| `GET` | `/api/complaints/:complaintId` | Consulta una reclamación y su historial, sujeto a autorización de sucursal. |
| `POST` | `/api/complaints/:complaintId/status`, `/api/complaints/:complaintId/response` | Actualiza el estado o registra la primera respuesta; ambos resultados conservan el historial. |
| `POST` | `/api/complaints/:complaintId/draft-response` | Solicita a Foundry un borrador neutro basado solo en categoría y estado. Requiere revisión y aprobación explícita para registrarlo; no envía mensajes al cliente. |

El chat conserva el ID de conversación del proveedor mediante un identificador opaco temporal en memoria. Las conversaciones se asocian a la identidad Entra validada; en modo local de desarrollo, a un identificador de sesión aleatorio del navegador. La memoria caduca en una hora y no constituye una sesión empresarial ni un sistema de autenticación.

## Entorno público de evaluación

Para publicar una experiencia sin inicio de sesión, ejecuta una **instancia de servidor independiente** con `RIOCLARO_EVALUATION_MODE=true` y configura `RIOCLARO_EVALUATION_DATA_FILE` como ruta absoluta a un archivo nuevo y exclusivo del entorno. El arranque redirige el store a ese archivo y crea también archivos dedicados de auditoría y conversaciones de Foundry (`RIOCLARO_EVALUATION_AUDIT_FILE` y `RIOCLARO_EVALUATION_CONVERSATIONS_FILE` son opcionales si se aceptan sus rutas derivadas). Si los archivos no tienen rutas absolutas o coinciden con los archivos operativos configurados/conocidos, el servidor no inicia en modo de evaluación. No compartas volúmenes de datos de evaluación y producción.

En ese modo la API ignora `X-Data-Origin`, URL, cuerpo y cualquier rol declarado por el navegador; todas las rutas de inventario, facturas, reclamaciones y contexto de Foundry quedan fijadas en el origen `practice`. Las rutas de administración (auditoría, restablecimiento y control de IA) continúan requiriendo un token real con rol Administrator. Las operaciones de negocio permitidas anónimamente solo pueden cambiar el almacén sintético de esa instancia. La identidad administrada del servidor para Foundry sigue siendo una credencial de servicio independiente de la sesión local de cada visitante; Foundry solo recibe el contexto sintético que arma el servidor.

La raíz `/` sirve directamente el dashboard y no requiere cookies ni autenticación web. Cuando el estado del servidor confirma el modo de evaluación, la interfaz oculta el selector de origen y habilita los formularios sintéticos sin ofrecer perfiles ni acceso empresarial. El reporte comercial se calcula con registros sintéticos generados por el servidor. La extracción de documentos externos queda bloqueada en el modo público. Si Foundry no está configurado, el asistente informa que no generó respuesta y el resto de la app sigue disponible.

## Atención de reclamaciones

La sección **Atención de reclamaciones** permite registrar un caso, filtrar la bandeja por sucursal y estado, abrir su detalle e historial, registrar la primera respuesta y actualizar el estado. Los medios de contacto solo se envían si se marca la autorización correspondiente. La bandeja exige seleccionar una sucursal y verifica que los elementos recibidos correspondan a ella; la autorización definitiva sigue correspondiendo a la API. El indicador SLA muestra el tiempo transcurrido, advierte desde los 12 minutos y destaca el incumplimiento a partir de los 15 minutos sin primera respuesta. Si Foundry está conectado, puede generar un borrador neutral usando categoría y estado, sin enviar datos de contacto o descripción al agente. El texto se debe revisar, modificar si corresponde y aprobar explícitamente antes de registrarse; no se contacta automáticamente al cliente.

La aplicación todavía no incluye inicio de sesión web. Fuera del modo aislado de evaluación, los datos `operational` requieren un token Entra que esta interfaz no puede obtener y la API devolverá `401`; el selector de origen no concede permisos. No uses datos personales reales en el conjunto `practice`.

## Normalización de productos

Las capacidades y unidades se normalizan para comparación (`1 L`, `1L` y `1000 ml`), sin tratar capacidades diferentes como equivalentes. `Cloro 1L`, `CLORO LITRO` y `Blanqueador 1000ml` solo son candidatos a `Cloro 1 L`: faltan composición, presentación y fabricante en los datos de demostración, así que permanecen separados y marcados para revisión. No se suman existencias hasta una confirmación humana explícita por un administrador con justificación; la confirmación solo agrupa registros de sucursales distintas y mantiene sus IDs y cantidades por sucursal. Las altas equivalentes pendientes se bloquean y las confirmadas se registran bajo el nombre canónico.

La ruta de conciliación de factura recibe el nombre detectado (por ejemplo, `CLORO LITRO`) y devuelve el producto solo si el alias ya se confirmó; de otro modo devuelve candidatos y `requiresHumanReview: true`. Para facturas, la captura manual permanece disponible y el OCR opcional usa Azure AI Document Intelligence con PDF/JPG/PNG de hasta 5 MB. Se envía el documento directamente al servicio en memoria; no se escribe en disco. El resultado nunca aprueba una factura: campos incompletos se marcan sin estimarlos, se exige confirmar los importes y cualquier decisión de revisión necesita evidencia humana. Solo se admiten MXN, USD y EUR en esta versión; los totales con moneda desconocida no se precargan.

## Seguridad y alcance

- Helmet/CSP, CORS limitado, límites de tamaño y frecuencia, validación de entradas, errores genéricos y escape del contenido mostrado.
- Las operaciones administrativas siguen exigiendo roles Entra; habilitar el chat local no las habilita.
- En desarrollo local, las altas de productos y facturas sin inicio de sesión están limitadas al conjunto `practice`; el servidor local escucha solo en `127.0.0.1`. El conjunto `operational` requiere autenticación y roles, y todas las escrituras requieren identidad en producción.
- En producción el chat anónimo local está deshabilitado y el servidor requiere HTTPS reenviado; configura TLS y proxy antes del despliegue.
- No hay inicio de sesión web ni fuente corporativa integrada. Los almacenes JSON locales no ofrecen aislamiento empresarial ni persistencia durable/compartida garantizada en Azure App Service.
- El OCR opcional no se habilita en la evaluación pública. No hay aprobación financiera ni pagos; la revisión solo puede actualizar el estado y, si corresponde, crear un movimiento de inventario dentro de los datos autorizados.
- Los mensajes enviados a Foundry se someten a filtros de datos sensibles comunes, pero no se deben enviar datos personales, fiscales, financieros ni secretos. La mitigación de prompt injection y las fuentes del agente deben validarse con la configuración real.
- La auditoría de dependencias más reciente (`npm audit`) reporta cero vulnerabilidades tras actualizar el lockfile a `@azure/identity` 4.14.1 y `@azure/msal-node` 7.1.2. Vuelve a ejecutar la auditoría antes de cada publicación.

## Pruebas y estado actual

Ejecuta `npm test` para las pruebas HTTP, de seguridad, aislamiento, cálculos, voz, facturas, OCR inyectado y reclamaciones. Las dependencias de identidad, Foundry y Document Intelligence se inyectan en pruebas unitarias: eso valida los contratos del backend, no prueba una conexión Azure real.

El dictado integrado usa Web Speech API con locale `es-MX`; la transcripción permanece editable y solo se envía al pulsar el botón del chat. El reconocimiento depende de navegador, permisos, micrófono y HTTPS (excepto localhost); escribir siempre queda disponible. Las pruebas automatizadas no prueban físicamente el micrófono.

### Estado verificable de los cinco escenarios

| Persona / escenario | Evidencia local disponible | Validación externa pendiente |
|---|---|---|
| **Don Ernesto — ventas** | Reporte sintético calculado por el backend: fechas, cinco sucursales, ventas, unidades, promedio, productos y tendencia; control de sucursal probado. | Conectar una fuente de ventas real autorizada; verificar cifras con negocio. |
| **Laura — facturas** | Captura manual, detección de folios coincidentes, OCR opcional real a través de Document Intelligence, moneda controlada y revisión humana; nunca ejecuta pagos. Pruebas usan extractor inyectado. | Recurso, identidad y documentos de prueba aprobados; comprobar precisión OCR y proceso contable. |
| **Mariana — reclamaciones** | Alta, filtro por sucursal/estado, historial, SLA de 15 minutos, respuesta con aprobación humana obligatoria y borrador IA limitado. No envía mensajes al cliente. | Roles y datos operativos reales; validar el canal de atención y sus políticas. |
| **Toño — inventario por voz** | Micrófono en el chat principal, `es-MX`, transcripción editable, mismo flujo/contexto de inventario que texto y alternativa escrita; pruebas de contrato. | Compatibilidad del navegador, permisos y micrófono físico. |
| **Carlos — seguridad** | Validación de tokens/roles en backend, aislamiento de origen `practice`, permisos por sucursal, auditoría, filtros y control de suspensión de IA; regresiones automatizadas. | Entra, RBAC, persistencia, aislamiento y monitoreo de Azure con identidades reales. |

### Preparación de Azure App Service

- Inicio: `npm start` → `node server.js`. El servidor usa `process.env.PORT`; enlaza `0.0.0.0` en `NODE_ENV=production`.
- Estáticos: `public/`; comprobación: `GET /health`. Node 24 debe estar disponible en el stack seleccionado; no se ha probado en un App Service real.
- Configura `RIOCLARO_EVALUATION_MODE=true` solo en una instancia de evaluación sin inicio de sesión, con `RIOCLARO_EVALUATION_DATA_FILE` absoluto y separado. No conectes esa instancia a datos operativos.
- Configura `FOUNDRY_PROJECT_ENDPOINT`, `FOUNDRY_AGENT_NAME`, `FOUNDRY_ENABLED` y permisos RBAC de identidad administrada si se usará Foundry. Para OCR opcional, configura `DOCUMENT_INTELLIGENCE_ENDPOINT` y permiso `Cognitive Services User`.
- El filesystem local y los archivos JSON no son una base de datos durable/compartida para escalado o operación. En App Service configura almacenamiento persistente adecuado o sustituye el store antes de depender de él; prueba concurrencia, retención y recuperación.
- Antes de crear un paquete de publicación, revisa y excluye `.env`, los archivos de datos locales y `server/data/*.backup-*`. El `.gitignore` cubre estos backups, pero esta carpeta de trabajo no tiene repositorio Git y no se verificó el contenido de los archivos existentes.
- Configura HTTPS Only, proxy de confianza, health check, alertas, copias, cuotas y secretos; no despliegues datos reales hasta implementar autenticación web, permisos de aplicación y un diseño aprobado de aislamiento.

**URL pública:** Pendiente de publicación. No se ha desplegado la aplicación ni modificado recursos Azure.

### Evidencias para AI-901

- [ ] Captura del dashboard y reporte comercial marcado como sintético.
- [ ] Captura del inventario y de sus existencias por sucursal.
- [ ] Captura de factura pendiente y su decisión humana (sin datos reales).
- [ ] Captura de reclamación con historial/SLA y respuesta confirmada.
- [ ] Captura de chat y transcripción editable; no implica que Foundry esté conectado.
- [ ] Captura móvil a 390 px en navegador.

## Capturas para la entrega académica

1. Inicia la aplicación y abre `http://127.0.0.1:3000`.
2. Captura **Overview**, **Inventario**, **Revisión de facturas**, **Asistente IA** y **Acerca del proyecto** con la herramienta de capturas de Windows (`Win` + `Shift` + `S`).
3. Para móvil, usa las herramientas de desarrollador del navegador con una ventana de 390 px de ancho y captura la navegación y una tabla desplazable.
4. Mantén visibles las etiquetas **Datos de demostración** y **Conexión pendiente** cuando correspondan. No sustituyas ni edites los datos para aparentar una conexión real.

## Errores comunes

- **El puerto ya está ocupado:** usa, por ejemplo, `$env:PORT=3001; npm start` y abre `http://127.0.0.1:3001`.
- **El agente aparece sin configurar:** revisa que `FOUNDRY_PROJECT_ENDPOINT` tenga el formato de project endpoint moderno y que `FOUNDRY_ENABLED=true`.
- **Autenticación/permiso de Foundry:** ejecuta `az login`, selecciona la suscripción correcta y verifica el rol de la identidad en el proyecto.
- **El chat local sigue deshabilitado:** confirma `ALLOW_UNAUTHENTICATED_LOCAL_CHAT=true`, `NODE_ENV` distinto de `production` y reinicia el servidor.
- **Key Vault impide iniciar:** si `KEY_VAULT_URL` o `KEY_VAULT_SECRET_NAMES` están configurados, ambos deben ser válidos y la identidad debe tener acceso. Para ejecutar sin Key Vault, deja ambas variables vacías.
- **Error de IA:** usa **Verificar conexión**. La respuesta muestra únicamente el estado; revisa permisos, endpoint, agente y conectividad en el servidor sin publicar tokens.

## Antes de desplegar en Azure

1. Volver a ejecutar `npm audit` y `npm test` con el lockfile que se vaya a publicar.
2. Implementar inicio de sesión web y probar tokens/roles reales de Entra.
3. Configurar identidad administrada, permisos mínimos de Foundry y Key Vault si aplica.
4. Definir persistencia, retención, privacidad y aislamiento antes de conectar datos reales.
5. Configurar HTTPS Only, proxy de confianza, monitoreo y rate limiting compartido.
6. Validar la integración real y las respuestas del agente, incluidas fuentes y prompt injection.
7. Ejecutar pruebas de seguridad y accesibilidad con recursos aprobados.

No se han creado ni modificado recursos externos de Azure.
