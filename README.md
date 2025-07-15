# IntoTheCom CRM Calendar System

## 📋 Descripción del Proyecto

Sistema CRM integral para **IntoTheCom**, agencia de marketing digital, con sincronización avanzada de Google Calendar. Desarrollado para optimizar la gestión de reuniones, contactos y sincronización automática de eventos.

## 🏗️ Arquitectura del Sistema

### **Stack Tecnológico**
- **Backend**: Node.js + Express.js
- **Base de Datos**: PostgreSQL
- **Autenticación**: Google OAuth2
- **API Externa**: Google Calendar API v3
- **Frontend**: HTML5 + CSS3 + JavaScript Vanilla
- **Deployment**: Railway Cloud Platform
- **Control de Versiones**: Git + GitHub

### **Arquitectura de Archivos**
```
CRM Intothecom/
├── server.js              # Aplicación principal (Backend + Frontend)
├── package.json           # Dependencias del proyecto
├── .env                   # Variables de entorno (no incluido en repo)
├── README.md              # Esta documentación
├── public/                # Recursos estáticos
│   ├── Blanco sin fondo 72ppi.png    # Logo blanco para sidebar
│   └── negro sin fondo 72ppi.png     # Logo negro alternativo
└── .gitignore             # Archivos excluidos del repositorio
```

## 🚀 Funcionalidades Implementadas

### **1. Sistema de Autenticación Google**
- **OAuth2 Flow completo** con Google Calendar
- **Estado persistente** de autenticación
- **Manejo automático de tokens** y renovación
- **Desconexión segura** y limpieza de credenciales

### **2. Calendario Avanzado**
#### **Vistas Múltiples**
- **Vista Día**: Eventos del día seleccionado con detalles completos
- **Vista Semana**: Grid semanal con slots de tiempo optimizados
- **Vista Mes**: Calendario mensual con días clicables

#### **Navegación Inteligente**
- **Flechas de navegación** (anterior/siguiente) por fecha
- **Botón "Hoy"** que cambia automáticamente a vista día actual
- **Días clicables** en vista mensual para cambio directo a vista día
- **Títulos dinámicos** que muestran fecha/semana/mes actual

#### **Gestión de Eventos**
- **Sincronización en tiempo real** con Google Calendar
- **Cache inteligente** (1 minuto) para optimización de performance
- **Auto-sync cada 2 minutos** para actualizaciones automáticas
- **Filtrado preciso** de eventos por fecha sin desfase de timezone
- **Enlaces directos** a reuniones de Google Meet

### **3. Gestión de Contactos Inteligente**
- **Extracción automática** de contactos de eventos
- **Sistema de etiquetas** con sincronización automática
- **Filtrado avanzado** por etiquetas, nombre y email
- **Ordenamiento múltiple** (recientes, nombre, reuniones)
- **Vista detallada** clickeable con información editable
- **Tracking de reuniones** por contacto con historial
- **Contador de reuniones** por contacto
- **Carga automática** al cambiar a pestaña contactos
- **API REST** para consultas y actualizaciones

### **4. Sistema de Sincronización**
- **Sync manual** on-demand
- **Sync automático** en background
- **Detección de cambios** para evitar updates innecesarios
- **Manejo de errores** robusto con logging detallado

## 🔧 Configuración del Entorno

### **Variables de Entorno Requeridas**
```env
DATABASE_URL=postgresql://usuario:password@host:puerto/database
GOOGLE_CLIENT_ID=tu_google_client_id
GOOGLE_CLIENT_SECRET=tu_google_client_secret
GOOGLE_REDIRECT_URI=https://tu-dominio.com/api/auth/google/callback
NODE_ENV=production
PORT=8080
```

### **Dependencias NPM**
```json
{
  "express": "^4.18.2",
  "cors": "^2.8.5", 
  "pg": "^8.11.3",
  "googleapis": "^126.0.1",
  "dotenv": "^16.3.1"
}
```

## 🗄️ Esquema de Base de Datos

### **Tabla: contacts**
```sql
CREATE TABLE contacts (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  first_seen DATE NOT NULL,
  last_seen DATE NOT NULL,
  meeting_count INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### **Tabla: events**
```sql
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  google_event_id VARCHAR(255) UNIQUE NOT NULL,
  summary TEXT,
  start_time TIMESTAMP,
  end_time TIMESTAMP,
  attendees_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 🎨 Diseño Premium y UX

### **Branding IntoTheCom Extraordinario**
- **Color Principal**: `#FF6B00` (Naranja corporativo)
- **Gradientes Avanzados**: `linear-gradient(135deg, #FF6B00 0%, #FF8533 100%)`
- **Glassmorphism**: Efectos de vidrio translúcido con `backdrop-filter: blur(20px)`
- **Tipografía**: Fuente Inter para modernidad y legibilidad
- **Efectos de Profundidad**: Sombras multicapa y efectos 3D

### **Sidebar Extraordinaria**
- **Gradiente Oscuro**: `linear-gradient(135deg, #0c0c0c 0%, #1a1a1a 100%)`
- **Efectos de Hover**: Transformaciones con `translateX(4px)`
- **Barras Laterales Animadas**: Efectos de profundidad con gradientes
- **Transiciones Suaves**: `cubic-bezier(0.4, 0, 0.2, 1)` para fluidez
- **Iconos Minimalistas**: Sin emojis, solo formas geométricas profesionales

### **Componentes Premium**
- **Botones con Brillo**: Efectos de luz deslizante al hover
- **Modales con Glassmorphism**: Bordes redondeados y efectos de cristal
- **Formularios Interactivos**: Focus states con glow effects naranja
- **Cards con Profundidad**: Elevación en hover con sombras dinámicas
- **Filtros Avanzados**: Glassmorphism con efectos de profundidad
- **Badges de Etiquetas**: Gradientes y sombras profesionales

### **Efectos Visuales Avanzados**
- **Microinteracciones**: Hover effects con `translateY(-2px)`
- **Animaciones de Entrada**: `slideIn` y `fadeIn` para modales
- **Efectos de Cristal**: Múltiples capas de transparencia
- **Sombras Dinámicas**: Cambios de elevación según interacción
- **Variables CSS**: Sistema de colores y efectos consistente

### **Responsive Design**
- **Mobile First**: Adaptación automática a dispositivos móviles
- **Sidebar Responsive**: Colapsa elegantemente en pantallas pequeñas
- **Grid Flexible**: Calendario adaptativo con efectos preservados
- **Touch Friendly**: Elementos optimizados para dispositivos táctiles

## 📡 API Endpoints

### **Autenticación**
- `GET /api/auth/google` - Iniciar flujo OAuth2
- `GET /api/auth/google/callback` - Callback de autenticación
- `POST /api/auth/disconnect` - Desconectar cuenta Google

### **Calendario**
- `GET /api/calendar/events?view={day|week|month}&date=YYYY-MM-DD` - Obtener eventos
- `GET /api/calendar/sync` - Sincronización manual

### **Contactos**
- `GET /api/contacts` - Listar todos los contactos
- `GET /api/contacts/new?days=N` - Contactos de últimos N días
- `POST /api/sync` - Sincronizar contactos desde eventos

### **Sistema**
- `GET /health` - Health check del servidor

## 🔍 Funcionalidades Técnicas Avanzadas

### **Manejo de Timezone**
```javascript
// Función helper para evitar desfase de fechas
function getLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}
```

### **Cache Management**
- **Duración**: 1 minuto para eventos de calendario
- **Invalidación**: Automática al cambiar fechas o vistas
- **Optimización**: Reduce llamadas API y mejora performance

### **Error Handling**
- **Manejo robusto** de errores de API de Google
- **Fallbacks automáticos** para reconexión
- **Logging detallado** para debugging
- **Mensajes user-friendly** en español

## 🚀 Deployment en Railway

### **Configuración**
1. **Conectar repositorio** GitHub a Railway
2. **Configurar variables** de entorno en Railway dashboard
3. **Deploy automático** desde branch main
4. **Database PostgreSQL** managed by Railway

### **URL de Producción**
```
https://crm-intothecom-production.up.railway.app/
```

## 🛠️ Comandos de Desarrollo

### **Instalación**
```bash
npm install
```

### **Desarrollo Local**
```bash
npm start
# Servidor disponible en http://localhost:8080
```

### **Testing de API**
```bash
# Health check
curl https://tu-dominio.com/health

# Obtener contactos
curl https://tu-dominio.com/api/contacts
```

## 📊 Logging y Debugging

### **Logs Implementados**
- **Navegación de fechas**: Track de cambios de vista y fecha
- **Filtrado de eventos**: Debug de selección de eventos por fecha
- **Sincronización**: Estado de sync con Google Calendar
- **Autenticación**: Estado de tokens y conexiones
- **Base de datos**: Operaciones CRUD con timestamps

### **Debug en Consola**
```javascript
// Ejemplos de logs disponibles
console.log('Navigation - Previous date:', prevDate, 'New date:', currentDate);
console.log('Day view filtering:', { selectedDate, totalEvents, eventsData });
console.log('Selected day from month view:', { dateString, selectedDate, view });
```

## 🔄 Historial de Versiones

### **v2.0 - Rediseño Premium con Glassmorphism (Diciembre 2024)**
- 🎨 **Transformación visual completa** con efectos de glassmorphism
- ✨ **Sidebar extraordinaria** con gradientes oscuros y efectos de profundidad
- 🎯 **Sistema de contactos inteligente** con filtrado avanzado por etiquetas
- 🔄 **Sincronización automática** de etiquetas evento-contacto
- 💎 **Modales premium** con animaciones suaves y efectos de cristal
- 🚀 **Botones con efectos de brillo** y microinteracciones
- 📱 **Carga automática** de contactos al cambiar pestañas
- 🎪 **Efectos de hover** con transformaciones 3D
- 🌟 **Branding consistente** en toda la plataforma
- 🔧 **Correcciones críticas** de funcionalidad post-redesign

### **v1.0 - Versión Estable Inicial**
- ✅ Sistema completo de autenticación Google
- ✅ Calendario multi-vista funcional
- ✅ Navegación avanzada con botón "Hoy"
- ✅ Días clicables en vista mensual
- ✅ Sincronización automática de eventos
- ✅ Gestión completa de contactos
- ✅ Fix crítico de timezone en selección de fechas
- ✅ UI/UX optimizada con branding IntoTheCom
- ✅ Deploy estable en Railway

## 🔮 Roadmap Futuro

### **Mejoras Planificadas**
- [ ] **Notificaciones Push** para próximas reuniones
- [ ] **Filtros avanzados** por tipo de evento o contacto
- [ ] **Dashboard analytics** con métricas de reuniones
- [ ] **Integración CRM** con leads y oportunidades
- [ ] **Exportación de datos** a CSV/Excel
- [ ] **API REST completa** para integraciones externas
- [ ] **Multi-usuario** con roles y permisos
- [ ] **Webhooks** para eventos de Google Calendar

## 👨‍💻 Información de Desarrollo

### **Desarrollado por**: Claude Code AI Assistant
### **Cliente**: IntoTheCom - Agencia de Marketing Digital
### **Período**: 2025
### **Tecnologías**: Node.js, PostgreSQL, Google Calendar API
### **Deployment**: Railway Cloud Platform

## 📞 Soporte Técnico

Para issues o mejoras, crear ticket en el repositorio GitHub:
```
https://github.com/imc400/crm-intothecom/issues
```

## 🔐 Consideraciones de Seguridad

- **OAuth2** implementado según mejores prácticas
- **Variables de entorno** para datos sensibles
- **HTTPS** obligatorio en producción
- **Validación** de inputs en todas las APIs
- **Rate limiting** implícito vía Google API quotas

---

## 🤖 Contexto de Desarrollo para IA

### **Información para Continuación de Desarrollo**

**Esta sección contiene contexto específico para asistentes de IA que continúen el desarrollo del proyecto.**

#### **Problemas Críticos Resueltos**

1. **Errores JavaScript Críticos (Resueltos)**
   - **Error**: `Uncaught SyntaxError: Unexpected string` en onclick handlers
   - **Causa**: Caracteres especiales sin escapar en strings JavaScript
   - **Solución**: Implementación de función `safeOnclick()` para escape automático
   - **Ubicación**: `server.js:head section` - función helper para escape de caracteres

2. **Función No Definida (Resuelto)**
   - **Error**: `authenticateGoogle is not defined`
   - **Causa**: Función definida después de su uso en onclick handlers
   - **Solución**: Creación de `window.startGoogleAuth` en head section
   - **Ubicación**: `server.js:head section` - función de autenticación global

3. **Contactos con Etiquetas No Sincronizados (Resuelto)**
   - **Problema**: Contactos con etiquetas en eventos no aparecían en pestaña contactos
   - **Causa**: Falta de sincronización entre tablas events y contacts
   - **Solución**: Endpoint `/api/sync-attendee-tags` para sincronización automática
   - **Ubicación**: `server.js:1847-1892` - sincronización de etiquetas

4. **Funcionalidad Rota Post-Rediseño (Resuelto)**
   - **Problema**: Scroll y clicks no funcionaban después del rediseño glassmorphism
   - **Causa**: CSS `overflow: hidden` y z-index mal configurados
   - **Solución**: `overflow-y: auto` y `pointer-events: none` en pseudo-elementos
   - **Ubicación**: `server.js:CSS section` - ajustes de z-index y overflow

#### **Arquitectura del Código**

**Archivo Principal**: `server.js` (Aplicación monolítica)
- **Líneas 1-200**: Configuración de servidor, database, y autenticación
- **Líneas 200-500**: Endpoints de API REST
- **Líneas 500-1000**: Lógica de sincronización y contactos
- **Líneas 1000-1500**: HTML templates y estructura
- **Líneas 1500-2000**: CSS con efectos glassmorphism
- **Líneas 2000-2500**: JavaScript frontend y funcionalidad

#### **Funciones Críticas a Preservar**

1. **Autenticación Google** (`server.js:head section`)
   ```javascript
   window.startGoogleAuth = function() {
     fetch('/api/auth/google')
       .then(response => response.json())
       .then(result => {
         if (result.success && result.authUrl) {
           window.open(result.authUrl, '_blank');
         }
       });
   };
   ```

2. **Sincronización de Etiquetas** (`server.js:1847-1892`)
   ```javascript
   app.post('/api/sync-attendee-tags', async (req, res) => {
     // Sincroniza etiquetas entre eventos y contactos
     // CRÍTICO: No modificar sin entender el flujo completo
   });
   ```

3. **Función Helper SafeOnclick** (`server.js:head section`)
   ```javascript
   function safeOnclick(str) {
     return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
   }
   ```

#### **Efectos CSS Glassmorphism**

**Variables CSS Críticas**:
```css
:root {
  --primary-orange: #FF6B00;
  --glass-bg: rgba(255, 255, 255, 0.1);
  --glass-border: rgba(255, 255, 255, 0.2);
  --glass-blur: blur(20px);
}
```

**Efectos de Profundidad**:
- **Sidebar**: `background: linear-gradient(135deg, #0c0c0c 0%, #1a1a1a 100%)`
- **Glassmorphism**: `backdrop-filter: blur(20px)` + `border-radius: 16px`
- **Hover Effects**: `transform: translateY(-2px)` con `box-shadow` dinámico

#### **Base de Datos - Esquema Crítico**

**Tabla Contacts** (Con todas las migraciones aplicadas):
```sql
CREATE TABLE contacts (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  first_seen DATE NOT NULL,
  last_seen DATE NOT NULL,
  meeting_count INTEGER DEFAULT 1,
  tags TEXT[] DEFAULT '{}',          -- Añadido en migración
  notes TEXT,                        -- Añadido en migración
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### **Flujo de Autenticación Google**

1. **Inicio**: `window.startGoogleAuth()` llamado desde botón
2. **Redirect**: `/api/auth/google` genera URL de OAuth2
3. **Callback**: `/api/auth/google/callback` procesa respuesta
4. **PostMessage**: `window.postMessage` notifica éxito a ventana principal
5. **Reload**: Frontend recarga eventos automáticamente

#### **Patrones de Código Importantes**

1. **Escape de Caracteres**: Siempre usar `safeOnclick()` para onclick handlers
2. **Gestión de Estado**: Cache de eventos con TTL de 1 minuto
3. **Error Handling**: Try-catch en todas las funciones async
4. **Logging**: Console.log detallado para debugging
5. **Responsive**: Mobile-first con efectos preservados

#### **Comandos de Mantenimiento**

```bash
# Verificar estado de la aplicación
curl https://crm-intothecom-production.up.railway.app/health

# Revisar logs en Railway
railway logs

# Backup de base de datos
railway run pg_dump $DATABASE_URL > backup.sql
```

#### **Warnings Críticos para Desarrolladores**

⚠️ **NUNCA** modificar el orden de las funciones JavaScript sin verificar dependencias
⚠️ **NUNCA** cambiar z-index sin considerar el efecto en glassmorphism
⚠️ **NUNCA** modificar `/api/sync-attendee-tags` sin entender el flujo completo
⚠️ **SIEMPRE** usar `safeOnclick()` para nuevos onclick handlers
⚠️ **SIEMPRE** probar scroll y clicks después de cambios CSS

#### **Próximos Pasos Sugeridos**

1. **Separar código**: Dividir server.js en módulos (backend/frontend)
2. **Testing**: Implementar tests unitarios para funciones críticas
3. **Performance**: Optimizar cache de eventos y contactos
4. **Monitoring**: Implementar logging estructurado
5. **Security**: Audit de seguridad en autenticación OAuth2

#### **Contacto de Referencia**

- **Cliente**: IntoTheCom (Agencia de Marketing Digital)
- **Requerimientos**: Plataforma "extraordinaria" con efecto "WOW"
- **Prioridad**: Funcionalidad > Estética (pero ambas críticas)
- **Filosofía**: "Necesito que actúes como un pro del desarrollo web... no soluciones parches"

---

**🎯 Proyecto completado exitosamente con todas las funcionalidades requeridas para un CRM profesional de agencia de marketing digital.**