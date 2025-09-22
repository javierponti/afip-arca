import Afip from '@afipsdk/afip.js';
import express from "express";

const app = express();
const port = process.env.PORT || 3001;

// ===== CONFIGURACIONES =====
const AFIP_CONFIG = {
  access_token: process.env.AFIP_ACCESS_TOKEN || 'TU_ACCESS_TOKEN',
  timeout: 120000,
  delayBetweenRequests: 3000, // 3 segundos entre requests para no saturar AFIP
  maxRetries: 2,
  
  TIPOS_COMPROBANTES: {
    1: 'Factura A', 6: 'Factura B', 11: 'Factura C',
    2: 'Nota de Débito A', 7: 'Nota de Débito B', 12: 'Nota de Débito C',
    3: 'Nota de Crédito A', 8: 'Nota de Crédito B', 13: 'Nota de Crédito C',
    51: 'Factura M', 52: 'Nota de Débito M', 53: 'Nota de Crédito M'
  }
};

// ===== MIDDLEWARES =====
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS para N8N
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

// ===== FUNCIONES DE UTILIDAD =====
function validateCUIT(cuit) {
  if (!/^\d{11}$/.test(cuit)) {
    return { valid: false, message: 'CUIT debe tener 11 dígitos numéricos' };
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
  
  if (dateDesde > dateHasta) {
    return { valid: false, message: 'Fecha desde no puede ser mayor que fecha hasta' };
  }
  
  // Límite de 1 año para evitar timeouts
  const diffTime = Math.abs(dateHasta - dateDesde);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays > 365) {
    return { valid: false, message: 'El rango no puede ser mayor a 365 días' };
  }
  
  return { valid: true };
}

function formatComprobante(comprobante, tipo, cuit) {
  return {
    // Datos originales
    ...comprobante,
    
    // Enriquecimientos
    cuitCliente: cuit,
    tipoConsulta: tipo,
    tipoDescripcion: AFIP_CONFIG.TIPOS_COMPROBANTES[comprobante.tipoComprobante] || `Tipo ${comprobante.tipoComprobante}`,
    importeFormateado: new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS'
    }).format(parseFloat(comprobante.importe) || 0),
    fechaFormateada: comprobante.fecha ? new Date(comprobante.fecha.split('/').reverse().join('-')).toLocaleDateString('es-AR') : '',
    procesadoEn: new Date().toISOString(),
    
    // Para N8N: campos útiles para filtrado y agrupación
    esFactura: [1, 6, 11, 51].includes(parseInt(comprobante.tipoComprobante)),
    esNotaDebito: [2, 7, 12, 52].includes(parseInt(comprobante.tipoComprobante)),
    esNotaCredito: [3, 8, 13, 53].includes(parseInt(comprobante.tipoComprobante)),
    requiereRevision: !comprobante.cae || comprobante.estado?.toLowerCase().includes('rechaz') || parseFloat(comprobante.importe || 0) > 500000
  };
}

async function consultarAfip(cliente, tipo, periodo) {
  const { cuit, username, password } = cliente;
  const { fechaDesde, fechaHasta } = periodo;
  
  console.log(`[${new Date().toISOString()}] Consultando ${tipo} para CUIT: ${cuit}`);
  
  const filters = {
    t: tipo,
    fechaEmision: `${fechaDesde} - ${fechaHasta}`,
    // Filtros básicos que funcionan bien con AFIP
    ...(tipo === 'R' && { tipoDoc: 80, nroDoc: cuit })
  };
  
  const data = {
    cuit,
    username: username || cuit, // Si no viene username, usar el CUIT
    password,
    filters
  };
  
  const afip = new Afip({ access_token: AFIP_CONFIG.access_token });
  
  // Intentos con retry
  for (let attempt = 1; attempt <= AFIP_CONFIG.maxRetries; attempt++) {
    try {
      const response = await Promise.race([
        afip.CreateAutomation("mis-comprobantes", data, true),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout de consulta AFIP')), AFIP_CONFIG.timeout)
        )
      ]);
      
      // Procesar respuesta
      const comprobantes = (response.data || []).map(comp => 
        formatComprobante(comp, tipo, cuit)
      );
      
      return {
        success: true,
        cuit,
        tipo,
        cantidad: comprobantes.length,
        comprobantes,
        totalImporte: comprobantes.reduce((sum, c) => sum + parseFloat(c.importe || 0), 0),
        resumen: generateResumen(comprobantes),
        procesadoEn: new Date().toISOString()
      };
      
    } catch (error) {
      console.error(`Intento ${attempt}/${AFIP_CONFIG.maxRetries} falló para ${cuit}:`, error.message);
      
      if (attempt === AFIP_CONFIG.maxRetries) {
        return {
          success: false,
          cuit,
          tipo,
          error: error.message,
          codigo: error.code || 'AFIP_ERROR',
          intentos: attempt,
          procesadoEn: new Date().toISOString()
        };
      }
      
      // Esperar antes del siguiente intento
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

function generateResumen(comprobantes) {
  const resumen = {
    total: comprobantes.length,
    porTipo: {},
    porEstado: {},
    facturas: 0,
    notasDebito: 0,
    notasCredito: 0,
    requierenRevision: 0
  };
  
  comprobantes.forEach(c => {
    // Por tipo de comprobante
    resumen.porTipo[c.tipoDescripcion] = (resumen.porTipo[c.tipoDescripcion] || 0) + 1;
    
    // Por estado
    if (c.estado) {
      resumen.porEstado[c.estado] = (resumen.porEstado[c.estado] || 0) + 1;
    }
    
    // Contadores específicos
    if (c.esFactura) resumen.facturas++;
    if (c.esNotaDebito) resumen.notasDebito++;
    if (c.esNotaCredito) resumen.notasCredito++;
    if (c.requiereRevision) resumen.requierenRevision++;
  });
  
  return resumen;
}

// ===== ENDPOINT PRINCIPAL: COMPROBANTES EMITIDOS =====
app.post('/comprobantes/emitidos', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { clientes, periodo } = req.body;
    
    // Validaciones de entrada
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
    
    // Validar período
    const dateValidation = validateDateRange(periodo.fechaDesde, periodo.fechaHasta);
    if (!dateValidation.valid) {
      return res.status(400).json({
        success: false,
        error: dateValidation.message,
        code: 'INVALID_DATE_RANGE'
      });
    }
    
    console.log(`[${new Date().toISOString()}] Iniciando procesamiento de ${clientes.length} clientes - EMITIDOS`);
    
    const resultados = {};
    const errores = [];
    let procesados = 0;
    let exitosos = 0;
    
    // Procesar clientes UNO POR UNO (crucial para no saturar AFIP)
    for (const cliente of clientes) {
      const { cuit, username, password } = cliente;
      
      // Validar cliente individual
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
      
      try {
        // Consultar AFIP para este cliente
        const resultado = await consultarAfip(cliente, 'E', periodo);
        
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
        
      } catch (error) {
        console.error(`Error procesando cliente ${cuit}:`, error);
        errores.push({
          cuit,
          error: error.message,
          code: 'PROCESSING_ERROR'
        });
      }
      
      procesados++;
      
      // Delay entre requests (CRUCIAL para AFIP)
      if (procesados < clientes.length) {
        console.log(`Esperando ${AFIP_CONFIG.delayBetweenRequests}ms antes del siguiente cliente...`);
        await new Promise(resolve => setTimeout(resolve, AFIP_CONFIG.delayBetweenRequests));
      }
    }
    
    // Respuesta final
    const response = {
      success: true,
      tipo: 'emitidos',
      periodo: `${periodo.fechaDesde} - ${periodo.fechaHasta}`,
      resumen: {
        totalClientes: clientes.length,
        procesados,
        exitosos,
        conErrores: errores.length,
        tiempoTotal: Date.now() - startTime
      },
      resultados,
      errores: errores.length > 0 ? errores : undefined,
      timestamp: new Date().toISOString()
    };
    
    console.log(`[${new Date().toISOString()}] Procesamiento completado: ${exitosos}/${clientes.length} exitosos`);
    
    res.json(response);
    
  } catch (error) {
    console.error('Error en endpoint emitidos:', error);
    
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor',
      message: error.message,
      code: 'INTERNAL_ERROR',
      timestamp: new Date().toISOString()
    });
  }
});

// ===== ENDPOINT PRINCIPAL: COMPROBANTES RECIBIDOS =====
app.post('/comprobantes/recibidos', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { clientes, periodo } = req.body;
    
    // Validaciones idénticas a emitidos
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
    
    console.log(`[${new Date().toISOString()}] Iniciando procesamiento de ${clientes.length} clientes - RECIBIDOS`);
    
    const resultados = {};
    const errores = [];
    let procesados = 0;
    let exitosos = 0;
    
    // Procesar UNO POR UNO
    for (const cliente of clientes) {
      const { cuit, username, password } = cliente;
      
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
      
      try {
        const resultado = await consultarAfip(cliente, 'R', periodo);
        
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
        
      } catch (error) {
        console.error(`Error procesando cliente ${cuit}:`, error);
        errores.push({
          cuit,
          error: error.message,
          code: 'PROCESSING_ERROR'
        });
      }
      
      procesados++;
      
      // Delay entre requests
      if (procesados < clientes.length) {
        await new Promise(resolve => setTimeout(resolve, AFIP_CONFIG.delayBetweenRequests));
      }
    }
    
    const response = {
      success: true,
      tipo: 'recibidos', 
      periodo: `${periodo.fechaDesde} - ${periodo.fechaHasta}`,
      resumen: {
        totalClientes: clientes.length,
        procesados,
        exitosos,
        conErrores: errores.length,
        tiempoTotal: Date.now() - startTime
      },
      resultados,
      errores: errores.length > 0 ? errores : undefined,
      timestamp: new Date().toISOString()
    };
    
    console.log(`[${new Date().toISOString()}] Procesamiento completado: ${exitosos}/${clientes.length} exitosos`);
    
    res.json(response);
    
  } catch (error) {
    console.error('Error en endpoint recibidos:', error);
    
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor',
      message: error.message,
      code: 'INTERNAL_ERROR',
      timestamp: new Date().toISOString()
    });
  }
});

// ===== ENDPOINTS DE UTILIDAD =====

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    version: '2.0.0-n8n',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    endpoints: {
      'POST /comprobantes/emitidos': 'Procesar comprobantes emitidos por lotes',
      'POST /comprobantes/recibidos': 'Procesar comprobantes recibidos por lotes',
      'GET /health': 'Health check',
      'GET /tipos-comprobantes': 'Catálogo de tipos'
    },
    configuracion: {
      delayEntreRequests: `${AFIP_CONFIG.delayBetweenRequests}ms`,
      timeoutPorConsulta: `${AFIP_CONFIG.timeout}ms`,
      maxReintentos: AFIP_CONFIG.maxRetries
    }
  });
});

// Tipos de comprobantes
app.get('/tipos-comprobantes', (req, res) => {
  res.json({
    success: true,
    tipos: AFIP_CONFIG.TIPOS_COMPROBANTES,
    timestamp: new Date().toISOString()
  });
});

// Endpoint de prueba individual (útil para testing)
app.post('/test-cliente', async (req, res) => {
  try {
    const { cuit, username, password, tipo = 'E', fechaDesde = '01/01/2024', fechaHasta = '31/12/2024' } = req.body;
    
    if (!cuit || !password) {
      return res.status(400).json({
        success: false,
        error: 'CUIT y password requeridos'
      });
    }
    
    const cliente = { cuit, username, password };
    const periodo = { fechaDesde, fechaHasta };
    
    const resultado = await consultarAfip(cliente, tipo, periodo);
    
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

// ===== MANEJO DE ERRORES =====
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
      'GET /tipos-comprobantes'
    ]
  });
});

// ===== INICIAR SERVIDOR =====
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 API AFIP-N8N optimizada ejecutándose en puerto ${port}`);
  console.log(`📊 Health check: http://localhost:${port}/health`);
  console.log(`⚡ Configuración: ${AFIP_CONFIG.delayBetweenRequests}ms delay entre requests`);
  console.log(`🔄 Max reintentos: ${AFIP_CONFIG.maxRetries} por cliente`);
  console.log(`🌍 Para N8N usar: https://tu-dominio.easypanel.host`);
});

export default app;