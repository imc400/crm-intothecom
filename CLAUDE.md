# IntoTheCom CRM - Documentación Técnica

## 📋 Resumen del Proyecto

**Sistema CRM completo** desarrollado para IntoTheCom, una agencia de marketing digital. El sistema integra Google Calendar, gestión de contactos, finanzas, chat interno tipo Slack y perfiles de usuario.

## 🏗️ Arquitectura Actual

### Stack Tecnológico
- **Backend**: Node.js + Express.js
- **Base de datos**: PostgreSQL
- **Autenticación**: Google OAuth 2.0 + Express Sessions
- **Sesiones**: connect-pg-simple para persistencia
- **Chat en tiempo real**: Socket.io
- **File uploads**: Multer
- **Frontend**: HTML/CSS/JavaScript vanilla con glassmorphism UI
- **Deploy**: Railway con variables de entorno

### Estructura de Base de Datos

#### Tablas principales:
- `users` - **Usuarios autenticados con tokens OAuth individuales**
- `session` - **Sesiones persistentes de express-session**
- `contacts` - Gestión de contactos y leads
- `events` - Eventos del calendario de Google
- `tags` - Sistema de etiquetas dinámicas
- `contact_attachments` - Archivos adjuntos por contacto
- `contact_tag_history` - Historial de asignación de tags
- `client_contracts` - Contratos de clientes
- `monthly_billing` - Facturación mensual
- `projects` - Proyectos y pagos
- `project_payments` - Pagos de proyectos
- `uf_values` - Valores UF para conversión de moneda
- `chat_channels` - Canales de chat (#general, #proyectos, #random)
- `chat_messages` - Mensajes del chat
- `chat_members` - Miembros de canales
- `user_profiles` - Perfiles completos de usuarios

#### Esquema de la tabla `users`:
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  google_id VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  picture_url TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expiry TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

## 🏗️ Arquitectura Multi-Usuario (v2.0.0)

### Implementación de Sesiones y Autenticación

#### Express Sessions con PostgreSQL
- **Almacenamiento**: Sesiones persistentes en tabla `session` de PostgreSQL
- **Middleware**: `connect-pg-simple` para gestión automática de sesiones
- **Configuración**: Compatible con producción (Railway) y desarrollo local
- **Seguridad**: Cookies seguras y validación de dominio @intothecom.com

#### Google OAuth 2.0 Per-User
```javascript
// Scopes implementados para OAuth completo
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];
```

#### Flujo de Autenticación Unificado
1. **Login**: Usuario inicia sesión con Google OAuth
2. **Authorization**: Sistema solicita permisos de calendario + perfil
3. **Token Storage**: Tokens se almacenan en tabla `users` por usuario
4. **Session Creation**: Se crea sesión persistente individual
5. **Calendar Access**: Usuario accede inmediatamente a su calendario personal

### Middleware de Autenticación

#### requireAuth Middleware
```javascript
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  next();
}
```

#### Función getOrCreateUser
- Busca usuario existente por `google_id`
- Crea nuevo usuario si no existe
- Actualiza tokens OAuth automáticamente
- Maneja renovación de access_tokens con refresh_tokens

### Gestión de Tokens OAuth

#### Almacenamiento Seguro
- `access_token`: Token temporal para API calls
- `refresh_token`: Token permanente para renovación
- `token_expiry`: Timestamp de expiración
- **Auto-refresh**: Renovación automática cuando el token expira

#### Validación de Usuario
- **Dominio**: Solo emails @intothecom.com permitidos
- **Perfil**: Extracción automática de nombre, email, foto
- **Persistencia**: Datos de usuario actualizados en cada login

### Calendar API per-User

#### Autenticación Individual
```javascript
// Cada usuario tiene su propio cliente OAuth
const oauth2Client = new google.auth.OAuth2(/* credentials */);
oauth2Client.setCredentials({
  access_token: user.access_token,
  refresh_token: user.refresh_token
});
```

#### Separación de Calendarios
- Cada usuario ve **solo sus eventos**
- Sincronización bidireccional individual
- Creación de eventos en calendario personal
- **No hay mezcla de datos** entre usuarios

### Mejoras en Calendar UX

#### Empty State Handling
- **Vista Semanal**: "No tienes eventos programados para esta semana"
- **Vista Mensual**: "No tienes eventos programados para este mes"
- **Vista Diaria**: "No tienes eventos programados para este día"
- **Funcionalidad preservada**: Botones de creación siguen activos

#### Renderizado Mejorado
- Calendarios vacíos se muestran completamente funcionales
- Mensajes amigables con instrucciones claras
- Eliminación de returns que bloqueaban funcionalidad
- Styling glassmorphism consistente

### Configuración de Producción

#### Railway Environment
```bash
# Variables de entorno para Railway
DATABASE_URL=postgresql://...
SESSION_SECRET=random_secure_string
NODE_ENV=production
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

#### Session Configuration
```javascript
// Configuración optimizada para Railway
cookie: {
  secure: process.env.NODE_ENV === 'production',
  maxAge: 24 * 60 * 60 * 1000, // 24 horas
  sameSite: 'lax'
}
```

## 🚀 Funcionalidades Implementadas

### 1. Sistema de Autenticación Multi-Usuario
- **Google OAuth 2.0 per-user** con tokens individuales
- **Express sessions** persistentes en PostgreSQL
- **Restricción a dominios** @intothecom.com
- **Unified OAuth flow** (login + calendar en un paso)
- **Auto-refresh de tokens** para mantener sesiones activas
- **Middleware de autenticación** robusto con redirects

### 2. Gestión de Contactos
- **CRUD completo** de contactos
- **Sistema de tags dinámico** con colores
- **Embudo de ventas** con filtros por etapa
- **Carga de archivos** por contacto (documentos, imágenes)
- **Historial de tags** con timestamps
- **Búsqueda y filtros** avanzados

### 3. Integración Google Calendar Multi-Usuario
- **Calendarios separados** por usuario autenticado
- **Sincronización bidireccional** individual con Google Calendar
- **Creación de eventos** en calendario personal desde el CRM
- **Detección automática** de nuevos contactos en reuniones
- **Gestión de asistentes** con tags automáticas
- **Vista de calendario** con 3 modalidades (semana, mes, día)
- **Empty state handling** con mensajes amigables en calendarios vacíos
- **Auto-refresh de tokens** para mantener acceso continuo

### 4. Sistema Financiero
- **Gestión de contratos** de clientes
- **Facturación mensual** con ajustes
- **Manejo dual de monedas** (CLP/UF)
- **Conversión automática** UF a CLP
- **Gestión de proyectos** con pagos
- **Dashboard financiero** con métricas

### 5. Chat Interno (Slack-like)
- **Chat en tiempo real** con Socket.io
- **Canales organizados** (#general, #proyectos, #random)
- **Mensajes persistentes** con historial
- **Avatares de usuario** (fotos o iniciales)
- **Integración con perfiles** de usuario

### 6. Sistema de Perfiles
- **Perfiles completos** con foto, nombre, cargo, departamento
- **Subida de fotos** de perfil
- **Formulario completo** con validación
- **Integración con chat** para mostrar nombres reales
- **Cache de perfiles** para performance

## 📁 Estructura del Proyecto

```
CRM-Intothecom/
├── server.js                 # Archivo principal con toda la lógica
├── package.json              # Dependencias del proyecto
├── .env                      # Variables de entorno
├── uploads/                  # Directorio para archivos subidos
├── public/                   # Archivos estáticos (si existen)
└── client_secret_*.json      # Credenciales de Google OAuth
```

## 🔧 Configuración del Entorno

### Variables de Entorno (.env)
```bash
DATABASE_URL=postgresql://user@localhost:5432/crm_db
PORT=3000
NODE_ENV=development
```

### Dependencias (package.json)
```json
{
  "dependencies": {
    "pg": "^8.11.3",
    "express": "^4.18.2", 
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "googleapis": "^126.0.1",
    "multer": "^1.4.5-lts.1",
    "socket.io": "^4.7.2"
  }
}
```

## 🎨 UI/UX Design

### Características de Diseño
- **Glassmorphism** con efectos de cristal
- **Dark mode** compatible
- **Responsive design** para móvil y desktop
- **Transiciones suaves** y micro-interacciones
- **Color scheme** profesional (azules y grises)

### Componentes UI
- **Sidebar navigation** con iconos
- **Tab system** para diferentes secciones
- **Modal dialogs** para formularios
- **Cards** con efectos de hover
- **Form styling** consistente

## 🔄 APIs Implementadas

### Autenticación
- `GET /api/auth/status` - Estado de autenticación
- `GET /auth/google` - Iniciar OAuth con Google
- `GET /auth/google/callback` - Callback de Google OAuth

### Contactos
- `GET /api/contacts` - Listar contactos
- `GET /api/contacts/new` - Contactos nuevos
- `POST /api/contacts` - Crear contacto
- `PUT /api/contacts/:id` - Actualizar contacto
- `DELETE /api/contacts/:id` - Eliminar contacto

### Archivos
- `POST /api/contacts/:id/attachments` - Subir archivo
- `GET /api/contacts/:id/attachments` - Listar archivos
- `DELETE /api/contacts/:contactId/attachments/:attachmentId` - Eliminar archivo

### Finanzas
- `GET /api/monthly-billing/:year/:month` - Facturación mensual
- `POST /api/monthly-billing` - Actualizar facturación
- `GET /api/projects` - Listar proyectos
- `POST /api/projects` - Crear proyecto

### Chat
- `GET /api/chat/channels` - Listar canales
- `GET /api/chat/channels/:id/messages` - Mensajes del canal
- `POST /api/chat/channels/:id/join` - Unirse a canal

### Perfiles
- `GET /api/profile` - Obtener perfil del usuario
- `POST /api/profile` - Guardar perfil
- `POST /api/profile/photo` - Subir foto de perfil

## 🛠️ Estado Actual del Sistema

### ✅ Funcionalidades Completamente Operativas
1. **Google Calendar Multi-Usuario** - Calendarios separados por usuario con OAuth individual
2. **Gestión de Contactos** - CRUD completo con tags y archivos
3. **Sistema Financiero** - Contratos, facturación y proyectos
4. **Chat interno** - Mensajería en tiempo real con canales
5. **Perfiles de usuario** - Formularios y fotos de perfil
6. **UI/UX** - Diseño profesional y responsivo con glassmorphism
7. **Autenticación Multi-Usuario** - Sessions persistentes y OAuth per-user
8. **Calendar Empty States** - Mensajes amigables en calendarios vacíos

### ✅ Limitaciones Resueltas (v2.0.0)
- ~~**Autenticación single-user**~~ → **Resuelto**: Sistema multi-usuario completo
- ~~**Calendarios compartidos**~~ → **Resuelto**: Calendarios separados por usuario
- ~~**Calendario vacío no funcional**~~ → **Resuelto**: Empty states con funcionalidad completa

### ⚠️ Limitaciones Pendientes
1. **Perfiles no auto-rellenados**: Email no se completa automáticamente desde OAuth
2. **Chat genérico**: No usa perfiles reales de usuarios autenticados
3. **Sin estado online/offline**: Chat no muestra status de usuarios
4. **Sin notificaciones push**: Solo notificaciones de browser básicas

## 🎯 Próximos Desarrollos Requeridos

### 1. ✅ ~~Sistema Multi-Usuario~~ (COMPLETADO)
- ✅ ~~Implementar express-session para sesiones individuales~~
- ✅ ~~Google OAuth per-user en lugar de global~~
- ✅ ~~Middleware de autenticación que valide @intothecom.com~~
- ✅ ~~Tokens por usuario en base de datos~~
- ✅ ~~Calendarios separados por usuario~~

### 2. Mejoras de UX (PRÓXIMA PRIORIDAD)
- **Auto-rellenado** de email en perfiles desde datos OAuth
- **Estado online/offline** en chat con Socket.io
- **Notificaciones push** en tiempo real
- **Búsqueda global** en el CRM (contactos, eventos, mensajes)
- **Dashboard personalizado** con widgets por usuario

### 3. Funcionalidades Avanzadas
- **Roles y permisos** (admin, user, manager, etc.)
- **Dashboard** con métricas personalizadas y KPIs
- **Integración con Google Drive** para documentos
- **Reportes automáticos** en PDF/Excel
- **API REST documentada** con Swagger/OpenAPI
- **Mobile responsive** mejorado para tablets

### 4. Optimizaciones Técnicas
- **WebSockets** optimizados para mejor performance del chat
- **Caching Redis** para queries frecuentes
- **CDN** para archivos estáticos
- **Monitoreo** con métricas de performance
- **Testing automatizado** con Jest

## 💻 Prompt Profesional para Desarrollo

```
Eres un desarrollador full-stack senior trabajando en el CRM de IntoTheCom. El sistema está basado en Node.js + PostgreSQL + Google APIs con arquitectura multi-usuario completa.

CONTEXTO ACTUAL v2.0.0:
- El CRM tiene integración completa multi-usuario con Google Calendar, gestión de contactos, finanzas, chat tipo Slack y perfiles de usuario
- SISTEMA MULTI-USUARIO COMPLETAMENTE FUNCIONAL con express-sessions y OAuth per-user
- Base de datos con 14+ tablas relacionadas incluyendo 'users' y 'session'
- UI glassmorphism profesional implementada con empty states
- Socket.io para chat en tiempo real
- Calendarios separados por usuario autenticado
- Tokens OAuth individuales con auto-refresh

ARQUITECTURA MULTI-USER IMPLEMENTADA:
- Express sessions con connect-pg-simple (PostgreSQL storage)
- Google OAuth 2.0 per-user con scopes: calendar, email, profile
- Middleware requireAuth para protección de rutas
- Función getOrCreateUser para gestión automática de usuarios
- Tabla 'users' con google_id, email, tokens OAuth, etc.
- Calendar API individual por usuario autenticado
- Empty state handling en todas las vistas de calendario

REGLAS DE DESARROLLO:
1. Mantener compatibilidad con el esquema de base de datos existente
2. Preservar toda la funcionalidad multi-usuario actual
3. Seguir el patrón de diseño glassmorphism establecido
4. Usar el mismo stack tecnológico (Node.js, Express, PostgreSQL, Socket.io)
5. Implementar logging detallado para debugging
6. Mantener APIs RESTful consistentes
7. Validar datos de entrada y manejar errores correctamente
8. Optimizar para performance (cache, queries eficientes)
9. SIEMPRE considerar el contexto multi-usuario (req.session.user)
10. Mantener separación de datos por usuario autenticado

ESTILO DE CÓDIGO:
- JavaScript ES6+ con async/await
- Queries SQL con parámetros ($1, $2, etc.)
- Manejo de errores con try/catch
- Logging con console.log descriptivo
- Nombres de variables en camelCase
- Comentarios en español para funciones importantes
- Middleware de autenticación en todas las rutas protegidas

PATRONES ESTABLECIDOS:
- req.session.user para obtener usuario actual
- await getOrCreateUser(googleProfile) para gestión de usuarios
- oauth2Client.setCredentials(user.tokens) para Calendar API
- Empty state handling con mensajes amigables
- Glassmorphism UI con clases .empty-calendar-message

ESTRUCTURA DE RESPUESTA:
1. Analizar el requerimiento considerando contexto multi-usuario
2. Proponer solución técnica que preserve arquitectura actual  
3. Implementar código con explicaciones detalladas
4. Testear funcionalidad en contexto multi-usuario
5. Documentar cambios realizados
6. Sugerir próximos pasos si aplica

Siempre considera el impacto en el sistema multi-usuario existente y proporciona soluciones robustas y escalables que mantengan la separación de datos por usuario.
```

## 🏷️ Historial de Versiones

### v1.0.0 - "Foundation" (Inicial)
- ✅ Google Calendar integration básica
- ✅ Contact management with tags  
- ✅ Financial system (contracts, billing, projects)
- ✅ Real-time chat system
- ✅ User profiles with photos
- ✅ Glassmorphism UI design
- ⚠️ Single-user authentication

### v2.0.0 - "Multi-User Authentication" (Actual)
- ✅ **Sistema multi-usuario completo** con express-session
- ✅ **Google OAuth per-user** con tokens individuales
- ✅ **Calendarios separados** por usuario autenticado
- ✅ **Middleware de autenticación** con validación @intothecom.com
- ✅ **Tabla users** para almacenar tokens OAuth por usuario
- ✅ **Sesiones persistentes** con connect-pg-simple
- ✅ **Calendar empty state handling** con mensajes amigables
- ✅ **Unified OAuth flow** (login + calendar en un solo paso)
- ✅ **Production-ready sessions** configuradas para Railway

### Próxima: v3.0.0 - "Enhanced UX"
- 🔄 Auto-rellenado de email en perfiles
- 🔄 Estado online/offline en chat
- 🔄 Notificaciones en tiempo real
- 🔄 Búsqueda global en el CRM

## 🚨 Notas Importantes

### Comandos Útiles
```bash
# Desarrollo local
npm start

# Verificar sintaxis
node -c server.js

# Base de datos
psql -d crm_db -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';"
```

### Debugging
- Logs detallados en consola durante operaciones
- Error handling en todas las APIs
- Estado de autenticación visible en UI
- Socket.io events loggeados

### Performance
- Cache de perfiles de usuario implementado
- Queries optimizadas con índices
- File uploads limitados a 50MB
- Compresión de imágenes recomendada

---

**Desarrollado para IntoTheCom** 🚀  
**Stack**: Node.js + Express + PostgreSQL + Google APIs + Socket.io  
**Status**: ✅ Sistema Multi-Usuario Completamente Funcional  
**Versión**: v2.0.0 - "Multi-User Authentication"  
**Deploy**: Railway Production Ready  

### 🎯 Próximas Mejoras Sugeridas:
1. **Auto-fill de perfiles** con datos OAuth
2. **Chat mejorado** con status online/offline  
3. **Dashboard personalizado** con métricas por usuario
4. **Notificaciones push** en tiempo real