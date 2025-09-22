import Afip from '@afipsdk/afip.js';
import express from "express";
import { promises as fs } from 'fs';
import path from 'path';

const app = express();
const port = process.env.PORT || 3001;

// ===== CONFIGURACIONES MEJORADAS =====
const AFIP_CONFIG = {
  access_token: process.env.AFIP_ACCESS_TOKEN || 'TU_ACCESS_TOKEN',
  timeout: parseInt(process.env.AFIP_TIMEOUT, 10) || 120000,
  delayBetweenRequests: parseInt(process.env.AFIP_DELAY, 10) || 3000,
  maxRetries: parseInt(process.env.AFIP_MAX_RETRIES, 10) || 2,
  
  // Límites de uso para prevenir abuso
  limits: {
    clienteDiario: parseInt(process.env.CLIENT_DAILY_LIMIT, 10) || 50,
    globalDiario: parseInt(process.env.GLOBAL_DAILY_LIMIT, 10) || 1000,
    requestsPorMinuto: parseInt(process.env.REQUESTS_PER_MINUTE, 10) || 20
  },
  
  TIPOS_COMPROBANTES: {
    1: 'Factura A', 6: 'Factura B', 11: 'Factura C',
    2: 'Nota de Débito A', 7: 'Nota de Débito B', 12: 'Nota de Débito C',
    3: 'Nota de Crédito A', 8: 'Nota de Crédito B', 13: 'Nota de Crédito C',
    51: 'Factura M', 52: 'Nota de Débito M', 53: 'Nota de Crédito M'
  }
};

// ===== SISTEMA DE TRACKING DE USO =====
class UsageTracker {
  constructor() {
    this.stats = {
      daily: {},
      requests: 0,
      successful: 0,
      failed: 0,
      byClient: {}
    };
    this.loadStats();
  }

  async loadStats() {
    try {
      const statsFile = path.join(process.cwd(), 'usage-stats.json');
      const data = await fs.readFile(statsFile, 'utf8');
      this.stats = { ...this.stats, ...JSON.parse(data) };
    } catch (error) {
      console.log('Iniciando nuevo archivo de estadísticas');
    }
  }

  async saveStats() {
    try {
      const statsFile = path.join(process.cwd(), 'usage-stats.json');
      await fs.writeFile(statsFile, JSON.stringify(this.stats, null, 2));
    } catch (error) {
      console.error('Error guardando estadísticas:', error);
    }
  }

  trackRequest(cuit, success = true, error = null) {
    const today = new Date().toISOString().split('T')[0];
    
    this.stats.requests++;
    if (success) {
      this.stats.successful++;
    } else {
      this.stats.failed++;
    }
    
    // Tracking por cliente
    if (!this.stats.byClient[cuit]) {
      this.stats.byClient[cuit] = { daily: {}, total: 0 };
    }
    
    if (!this.stats.byClient[cuit].daily[today]) {
      this.stats.byClient[cuit].daily[today] = 0;
    }
    
    this.stats.byClient[cuit].daily[today]++;
    this.stats.byClient[cuit].total++;
    
    // Tracking diario global
    if (!this.stats.daily[today]) {
      this.stats.daily[today] = 0;
    }
    this.stats.daily[today]++;
    
    this.saveStats();
  }

  checkLimits(cuit) {
    const today = new Date().toISOString().split('T')[0];
    const clientToday = this.stats.byClient[cuit]?.daily[today] || 0;
    const globalToday = this.stats.daily[today] || 0;
    
    return {
      withinLimits: clientToday < AFIP_CONFIG.limits.clienteDiario && globalToday < AFIP_CONFIG.limits.globalDiario,
      clientRequests: clientToday,
      globalRequests: globalToday,
      clientLimit: AFIP_CONFIG.limits.clienteDiario,
      globalLimit: AFIP_CONFIG.limits.globalDiario
    };
  }

  getStats() {
    const today = new Date().toISOString().split('T')[0];
    return {
      ...this.stats,
      today: {
        total: this.stats.daily[today] || 0,
        remaining: AFIP_CONFIG.limits.globalDiario - (this.stats.daily[today] || 0)
      },
      successRate: this.stats.requests > 0 ? ((this.stats.successful / this.stats.requests) * 100).toFixed(2) + '%' : '0%'
    };
  }
}

const usageTracker = new UsageTracker();

// ===== MIDDLEWARES =====
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS mejorado
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// ===== FUNCIONES DE UTILIDAD MEJORADAS =====
function validateCUIT(cuit) {
  if (!/^\d{11}$/.test(cuit)) {
    return { valid: false, message: 'CUIT debe tener 11 dígitos numéricos' };
  }
  
  // Validación de dígito verificador (MEJORADO)
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const digits = cuit.split('').map(Number);
  const checkDigit = digits[10];
  
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += digits[i] * weights[i];
  }
  
  const remainder = sum % 11;
  const calculatedCheckDigit = remainder < 2 ? remainder : 11 - remainder;
  
  if (calculatedCheckDigit !== checkDigit) {
    return { valid: false, message: 'CUIT inválido: dígito verificador incorrecto' };
  }
  
  return { valid: true };
}

function validateDateRange(fechaDesde, fechaHasta) {
  const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
  if (!dateRegex.test(fechaDesde) || !dateRegex.test(fechaHasta)) {
    return { valid: false, message: 'Formato de fecha debe ser DD/MM/YYYY' };
  }
  
  const [dDesde, mDesde, aDesde] = fechaDesde.split('/').map(Number);
  const [dHasta, mHasta, aHasta] = fechaHasta.split('/').map(Number);
  
  const dateDesde = new Date(aDesde, mDesde - 1, dDesde);
  const dateHasta = new Date(aHasta, mHasta - 1, dHasta);
  const today = new Date();
  
  if (dateDesde > today || dateHasta > today) {
    return { valid: false, message: 'No se pueden consultar fechas futuras' };
  }
  
  if (dateDesde > dateHasta) {
    return { valid: false, message: 'Fecha desde no puede ser mayor que fecha hasta' };
  }
  
  const diffTime = Math.abs(dateHasta - dateDesde);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays > 365) {
    return { valid: false, message: 'El rango no puede ser mayor a 365 días' };
  }
  
  return { valid: true };
}

function formatComprobante(comprobante, tipo, cuit) {
  const importe = parseFloat(comprobante.importe) || 0;
  return {
    ...comprobante,
    cuitCliente: cuit,
    tipoConsulta: tipo,
    tipoDescripcion: AFIP_CONFIG.TIPOS_COMPROBANTES[comprobante.tipoComprobante] || `Tipo ${comprobante.tipoComprobante}`,
    importeFormateado: new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS'
    }).format(importe),
    fechaFormateada: comprobante.fecha ? new Date(comprobante.fecha.split('/').reverse().join('-')).toLocaleDateString('es-AR') : '',
    procesadoEn: new Date().toISOString(),
    esFactura: [1, 6, 11, 51].includes(parseInt(comprobante.tipoComprobante, 10)),
    esNotaDebito: [2, 7, 12, 52].includes(parseInt(comprobante.tipoComprobante, 10)),
    esNotaCredito: [3, 8, 13, 53].includes(parseInt(comprobante.tipoComprobante, 10)),
    requiereRevision: !comprobante.cae || comprobante.estado?.toLowerCase().includes('rechaz') || importe > 500000
  };
}

function generateResumen(comprobantes) {
  const resumen = {
    total: comprobantes.length,
    porTipo: {},
    porEstado: {},
    facturas: 0,
    notasDebito: 0,
    notasCredito: 0,
    requierenRevision: 0,
    totalImporte: 0
  };
  
  comprobantes.forEach(c => {
    resumen.porTipo[c.tipoDescripcion] = (resumen.porTipo[c.tipoDescripcion] || 0) + 1;
    if (c.estado) {
      resumen.porEstado[c.estado] = (resumen.porEstado[c.estado] || 0) + 1;
    }
    if (c.esFactura) resumen.facturas++;
    if (c.esNotaDebito) resumen.notasDebito++;
    if (c.esNotaCredito) resumen.notasCredito++;
    if (c.requiereRevision) resumen.requierenRevision++;
    resumen.totalImporte += parseFloat(c.importe || 0);
  });
  
  return resumen;
}

async function consultarAfip(cliente, tipo, periodo) {
  const { cuit, username, password } = cliente;
  const { fechaDesde, fechaHasta } = periodo;
  
  console.log(`[${new Date().toISOString()}] Consultando ${tipo} para CUIT: ${cuit}`);
  
  const afip = new Afip({ access_token: AFIP_CONFIG.access_token });
  let lastError;

  for (let attempt = 1; attempt <= AFIP_CONFIG.maxRetries + 1; attempt++) {
    try {
      const responsePromise = afip.CreateAutomation("mis-comprobantes", {
        cuit,
        username: username || cuit,
        password,
        filters: {
          t: tipo,
          fechaEmision: `${fechaDesde} - ${fechaHasta}`,
          ...(tipo === 'R' && { tipoDoc: 80, nroDoc: cuit })
        }
      }, true);

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout de consulta AFIP')), AFIP_CONFIG.timeout)
      );

      const response = await Promise.race([responsePromise, timeoutPromise]);
      
      const comprobantes = (response.data || []).map(comp => formatComprobante(comp, tipo, cuit));
      
      // Track successful request
      usageTracker.trackRequest(cuit, true);
      
      return {
        success: true,
        cuit,
        tipo,
        cantidad: comprobantes.length,
        comprobantes,
        resumen: generateResumen(comprobantes),
        procesadoEn: new Date().toISOString()
      };
      
    } catch (error) {
      console.error(`Intento ${attempt}/${AFIP_CONFIG.maxRetries + 1} falló para ${cuit}:`, error.message);
      lastError = error;
      if (attempt <= AFIP_CONFIG.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }

  // Track failed request
  usageTracker.trackRequest(cuit, false, lastError);

  return {
    success: false,
    cuit,
    tipo,
    error: lastError.message,
    codigo: lastError.code || 'AFIP_ERROR',
    intentos: AFIP_CONFIG.maxRetries + 1,
    procesadoEn: new Date().toISOString()
  };
}

// ===== MIDDLEWARE DE LÍMITES =====
const checkLimits = (req, res, next) => {
  const { clientes } = req.body;
  
  if (!Array.isArray(clientes)) {
    return next();
  }
  
  // Verificar límites para cada cliente
  const limitExceeded = clientes.find(cliente => {
    const limits = usageTracker.checkLimits(cliente.cuit);
    return !limits.withinLimits;
  });
  
  if (limitExceeded) {
    const limits = usageTracker.checkLimits(limitExceeded.cuit);
    return res.status(429).json({
      success: false,
      error: 'Límite de uso excedido',
      code: 'USAGE_LIMIT_EXCEEDED',
      cuit: limitExceeded.cuit,
      details: limits
    });
  }
  
  next();
};

// ===== ENDPOINT PRINCIPAL MEJORADO =====
const handleComprobantesEndpoint = (tipo) => async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { clientes, periodo } = req.body;
    
    // Validaciones básicas
    if (!Array.isArray(clientes) || clientes.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'Se requiere un array de clientes no vacío', 
        code: 'INVALID_CLIENTS' 
      });
    }
    
    if (!periodo || !periodo.fechaDesde || !periodo.fechaHasta) {
      return res.status(400).json({ 
        success: false, 
        error: 'Se requiere periodo con fechaDesde y fechaHasta', 
        code: 'INVALID_PERIOD' 
      });
    }
    
    const dateValidation = validateDateRange(periodo.fechaDesde, periodo.fechaHasta);
    if (!dateValidation.valid) {
      return res.status(400).json({ 
        success: false, 
        error: dateValidation.message, 
        code: 'INVALID_DATE_RANGE' 
      });
    }
    
    console.log(`[${new Date().toISOString()}] Iniciando procesamiento de ${clientes.length} clientes - ${tipo === 'E' ? 'EMITIDOS' : 'RECIBIDOS'}`);
    
    const resultados = {};
    const errores = [];
    let exitosos = 0;
    
    // Procesar cada cliente con validaciones mejoradas
    for (const cliente of clientes) {
      const { cuit, password } = cliente;
      
      if (!cuit || !password) {
        errores.push({ 
          cuit: cuit || 'SIN_CUIT', 
          error: 'CUIT y password son requeridos', 
          code: 'MISSING_CREDENTIALS' 
        });
        continue;
      }
      
      const cuitValidation = validateCUIT(cuit);
      if (!cuitValidation.valid) {
        errores.push({ 
          cuit, 
          error: cuitValidation.message, 
          code: 'INVALID_CUIT' 
        });
        continue;
      }
      
      // Verificar límites por cliente
      const limits = usageTracker.checkLimits(cuit);
      if (!limits.withinLimits) {
        errores.push({
          cuit,
          error: `Cliente excedió límite diario (${limits.clientRequests}/${limits.clientLimit})`,
          code: 'CLIENT_LIMIT_EXCEEDED'
        });
        continue;
      }
      
      const resultado = await consultarAfip(cliente, tipo, periodo);
      resultados[cuit] = resultado;
      
      if (resultado.success) {
        exitosos++;
      } else {
        errores.push({ 
          cuit, 
          error: resultado.error, 
          code: resultado.codigo 
        });
      }
      
      // Delay entre requests (crucial para AFIP)
      if (cliente !== clientes[clientes.length - 1]) {
        console.log(`Esperando ${AFIP_CONFIG.delayBetweenRequests}ms antes del siguiente cliente...`);
        await new Promise(resolve => setTimeout(resolve, AFIP_CONFIG.delayBetweenRequests));
      }
    }
    
    const response = {
      success: true,
      tipo: tipo === 'E' ? 'emitidos' : 'recibidos',
      periodo: `${periodo.fechaDesde} - ${periodo.fechaHasta}`,
      resumen: {
        totalClientes: clientes.length,
        procesados: clientes.length,
        exitosos,
        conErrores: errores.length,
        tiempoTotal: Date.now() - startTime
      },
      resultados,
      errores: errores.length > 0 ? errores : undefined,
      timestamp: new Date().toISOString(),
      usage: usageTracker.getStats().today
    };
    
    console.log(`[${new Date().toISOString()}] Procesamiento completado: ${exitosos}/${clientes.length} exitosos`);
    res.json(response);
    
  } catch (error) {
    console.error(`Error en endpoint ${tipo === 'E' ? 'emitidos' : 'recibidos'}:`, error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor',
      message: error.message,
      code: 'INTERNAL_ERROR',
      timestamp: new Date().toISOString()
    });
  }
};

// ===== ENDPOINTS =====
app.post('/comprobantes/emitidos', checkLimits, handleComprobantesEndpoint('E'));
app.post('/comprobantes/recibidos', checkLimits, handleComprobantesEndpoint('R'));

// Endpoint de estadísticas (NUEVO)
app.get('/stats', (req, res) => {
  res.json({
    success: true,
    stats: usageTracker.getStats(),
    limites: AFIP_CONFIG.limits,
    timestamp: new Date().toISOString()
  });
});

// Health check mejorado
app.get('/health', (req, res) => {
  const stats = usageTracker.getStats();
  
  res.json({
    status: 'OK',
    version: '3.0.0-hybrid',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    usage: {
      today: stats.today,
      successRate: stats.successRate,
      totalRequests: stats.requests
    },
    configuracion: {
      delayEntreRequests: `${AFIP_CONFIG.delayBetweenRequests}ms`,
      timeoutPorConsulta: `${AFIP_CONFIG.timeout}ms`,
      maxReintentos: AFIP_CONFIG.maxRetries,
      limites: AFIP_CONFIG.limits
    }
  });
});

app.get('/tipos-comprobantes', (req, res) => {
  res.json({
    success: true,
    tipos: AFIP_CONFIG.TIPOS_COMPROBANTES,
    timestamp: new Date().toISOString()
  });
});

// Endpoint individual para testing
app.post('/test-cliente', async (req, res) => {
  try {
    const { cuit, username, password, tipo = 'E', fechaDesde, fechaHasta } = req.body;
    
    if (!cuit || !password) {
      return res.status(400).json({ 
        success: false, 
        error: 'CUIT y password requeridos' 
      });
    }
    
    const cuitValidation = validateCUIT(cuit);
    if (!cuitValidation.valid) {
      return res.status(400).json({
        success: false,
        error: cuitValidation.message
      });
    }
    
    const periodo = {
      fechaDesde: fechaDesde || '01/09/2024',
      fechaHasta: fechaHasta || '30/09/2024'
    };
    
    const resultado = await consultarAfip({ cuit, username, password }, tipo, periodo);
    
    res.json({
      success: true,
      mensaje: 'Prueba individual completada',
      resultado,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint no encontrado',
    code: 'NOT_FOUND',
    endpoints_disponibles: [
      'POST /comprobantes/emitidos',
      'POST /comprobantes/recibidos',
      'POST /test-cliente',
      'GET /health',
      'GET /stats',
      'GET /tipos-comprobantes'
    ]
  });
});

// ===== INICIAR SERVIDOR =====
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 API AFIP Híbrida v3.0.0 ejecutándose en puerto ${port}`);
  console.log(`📊 Health check: http://localhost:${port}/health`);
  console.log(`📈 Estadísticas: http://localhost:${port}/stats`);
  console.log(`⚡ Configuración: ${AFIP_CONFIG.delayBetweenRequests}ms delay entre requests`);
  console.log(`🔄 Max reintentos: ${AFIP_CONFIG.maxRetries} por cliente`);
  console.log(`🛡️ Límites: ${AFIP_CONFIG.limits.clienteDiario} por cliente/día, ${AFIP_CONFIG.limits.globalDiario} global/día`);
});

export default app;