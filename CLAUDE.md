# IntoTheCom CRM - Documentación Técnica

## 📋 Resumen del Proyecto

**Sistema CRM completo** desarrollado para IntoTheCom, una agencia de marketing digital. El sistema integra Google Calendar, gestión de contactos, finanzas, chat interno tipo Slack y perfiles de usuario.

## 🏗️ Arquitectura Actual

### Stack Tecnológico
- **Backend**: Node.js + Express.js
- **Base de datos**: PostgreSQL
- **Autenticación**: Google OAuth 2.0
- **Chat en tiempo real**: Socket.io
- **File uploads**: Multer
- **Frontend**: HTML/CSS/JavaScript vanilla con glassmorphism UI

### Estructura de Base de Datos

#### Tablas principales:
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

## 🚀 Funcionalidades Implementadas

### 1. Sistema de Autenticación
- **Google OAuth 2.0** integrado
- Restricción a dominios **@intothecom.com**
- Tokens persistentes en base de datos
- Status de autenticación en tiempo real

### 2. Gestión de Contactos
- **CRUD completo** de contactos
- **Sistema de tags dinámico** con colores
- **Embudo de ventas** con filtros por etapa
- **Carga de archivos** por contacto (documentos, imágenes)
- **Historial de tags** con timestamps
- **Búsqueda y filtros** avanzados

### 3. Integración Google Calendar
- **Sincronización bidireccional** con Google Calendar
- **Creación de eventos** desde el CRM
- **Detección automática** de nuevos contactos en reuniones
- **Gestión de asistentes** con tags automáticas
- **Vista de calendario** integrada en el CRM

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
1. **Google Calendar** - Integración bidireccional funcionando
2. **Gestión de Contactos** - CRUD completo con tags y archivos
3. **Sistema Financiero** - Contratos, facturación y proyectos
4. **Chat interno** - Mensajería en tiempo real con canales
5. **Perfiles de usuario** - Formularios y fotos de perfil
6. **UI/UX** - Diseño profesional y responsivo

### ⚠️ Limitaciones Identificadas
1. **Autenticación single-user**: Todos comparten la misma sesión de Google
2. **Calendarios compartidos**: No hay separación por usuario
3. **Perfiles no auto-rellenados**: Email no se completa automáticamente
4. **Chat genérico**: No usa perfiles reales de usuarios autenticados

## 🎯 Próximos Desarrollos Requeridos

### 1. Sistema Multi-Usuario (CRÍTICO)
- Implementar **express-session** para sesiones individuales
- **Google OAuth per-user** en lugar de global
- **Middleware de autenticación** que valide @intothecom.com
- **Tokens por usuario** en base de datos
- **Calendarios separados** por usuario

### 2. Mejoras de UX
- **Auto-rellenado** de email en perfiles
- **Estado online/offline** en chat
- **Notificaciones** en tiempo real
- **Búsqueda global** en el CRM

### 3. Funcionalidades Avanzadas
- **Roles y permisos** (admin, user, etc.)
- **Dashboard** con métricas personalizadas
- **Integración con Google Drive** como backend
- **Reportes** en PDF/Excel
- **API REST** documentada

## 💻 Prompt Profesional para Desarrollo

```
Eres un desarrollador full-stack senior trabajando en el CRM de IntoTheCom. El sistema está basado en Node.js + PostgreSQL + Google APIs.

CONTEXTO ACTUAL:
- El CRM tiene integración completa con Google Calendar, gestión de contactos, finanzas, chat tipo Slack y perfiles de usuario
- Funciona como single-user pero necesita ser multi-user real
- Base de datos con 12+ tablas relacionadas
- UI glassmorphism profesional implementada
- Socket.io para chat en tiempo real

REGLAS DE DESARROLLO:
1. Mantener compatibilidad con el esquema de base de datos existente
2. Preservar toda la funcionalidad actual mientras agregas nuevas features
3. Seguir el patrón de diseño glassmorphism establecido
4. Usar el mismo stack tecnológico (Node.js, Express, PostgreSQL, Socket.io)
5. Implementar logging detallado para debugging
6. Mantener APIs RESTful consistentes
7. Validar datos de entrada y manejar errores correctamente
8. Optimizar para performance (cache, queries eficientes)

ESTILO DE CÓDIGO:
- JavaScript ES6+ con async/await
- Queries SQL con parámetros ($1, $2, etc.)
- Manejo de errores con try/catch
- Logging con console.log descriptivo
- Nombres de variables en camelCase
- Comentarios en español para funciones importantes

ESTRUCTURA DE RESPUESTA:
1. Analizar el requerimiento en detalle
2. Proponer solución técnica específica  
3. Implementar código con explicaciones
4. Testear funcionalidad
5. Documentar cambios realizados
6. Sugerir próximos pasos si aplica

Siempre considera el impacto en el sistema existente y proporciona soluciones robustas y escalables.
```

## 🏷️ Historial de Versiones

### v1.0.0 - "Foundation" (Actual)
- ✅ Google Calendar integration
- ✅ Contact management with tags  
- ✅ Financial system (contracts, billing, projects)
- ✅ Real-time chat system
- ✅ User profiles with photos
- ✅ Glassmorphism UI design
- ⚠️ Single-user authentication

### Próxima: v2.0.0 - "Multi-User"
- 🔄 Individual user sessions
- 🔄 Per-user Google OAuth
- 🔄 Separated user calendars
- 🔄 Enhanced user management

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
**Stack**: Node.js + PostgreSQL + Google APIs + Socket.io  
**Status**: Funcional (single-user) → Migración a multi-user requerida