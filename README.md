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

### **3. Gestión de Contactos**
- **Extracción automática** de contactos de eventos
- **Tracking de reuniones** por contacto
- **Historial completo** (primera/última reunión)
- **Contador de reuniones** por contacto
- **API REST** para consultas de contactos

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

## 🎨 Diseño y UX

### **Branding IntoTheCom**
- **Color Principal**: `#FF6B00` (Naranja corporativo)
- **Sidebar Oscuro**: Con logo blanco para contraste
- **Tipografía**: Sans-serif moderna y limpia
- **Efectos Hover**: Transiciones suaves en elementos interactivos

### **Responsive Design**
- **Mobile First**: Adaptación automática a dispositivos móviles
- **Sidebar Responsive**: Se convierte en header en pantallas pequeñas
- **Grid Flexible**: Calendario adaptativo según tamaño de pantalla

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

**🎯 Proyecto completado exitosamente con todas las funcionalidades requeridas para un CRM profesional de agencia de marketing digital.**