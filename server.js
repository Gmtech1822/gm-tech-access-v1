const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const net = require('net');

const app = express();
const port = process.env.PORT || 3000;
const tcpPort = process.env.TCP_PORT || 10001; // Porta para receber Contact ID/SIA

app.use(cors());
app.use(express.json());

// Conexão PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicialização do Banco com Tabelas de Alarmes
const initDb = async () => {
  try {
    // Tabela de Câmeras/DVRs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cftv_cameras (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        fabricante VARCHAR(50) NOT NULL,
        ip VARCHAR(45) NOT NULL,
        porta_onvif INT DEFAULT 80,
        usuario VARCHAR(50),
        senha VARCHAR(50),
        rtsp_url TEXT,
        status VARCHAR(20) DEFAULT 'ONLINE',
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabela de Zonas de Alarme / Cercas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alarmes_zonas (
        id SERIAL PRIMARY KEY,
        central_nome VARCHAR(100) NOT NULL,
        numero_zona INT NOT NULL,
        tipo VARCHAR(50) DEFAULT 'ALARME', -- ALARME ou CERCA
        descricao VARCHAR(100),
        status VARCHAR(20) DEFAULT 'NORMAL', -- NORMAL, DISPARADO, BPASS
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabela de Logs de Eventos Geral
    await pool.query(`
      CREATE TABLE IF NOT EXISTS logs_eventos (
        id SERIAL PRIMARY KEY,
        dispositivo_nome VARCHAR(100) NOT NULL,
        tipo_dispositivo VARCHAR(50) NOT NULL,
        fabricante VARCHAR(50) NOT NULL,
        descricao_evento TEXT NOT NULL,
        status_evento VARCHAR(20) DEFAULT 'SUCESSO',
        recebido_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("Banco de dados sincronizado com tabelas de CFTV e Alarmes!");
  } catch (err) {
    console.error("Erro ao inicializar banco:", err);
  }
};

initDb();

// --- DECODER CONTACT ID ---
function decodificarContactID(rawBuffer) {
  const rawMsg = rawBuffer.toString('ascii');
  
  // Tabela rápida de eventos Contact ID comuns
  const codigos = {
    '1130': 'Disparo de Alarme - Conflito/Zona',
    '1134': 'Disparo - Invasão de Perímetro',
    '1381': 'Perda de Pulso - Cerca Elétrica',
    '1401': 'Desarme pelo Usuário',
    '3401': 'Arme pelo Usuário',
    '1301': 'Falha de Energia AC',
    '1120': 'Pânico Silencioso'
  };

  // Simulação de extração simples do payload da central
  for (let code in codigos) {
    if (rawMsg.includes(code)) {
      return codigos[code];
    }
  }

  return `Evento Contact ID Recebido: ${rawMsg.substring(0, 30)}`;
}

// --- SERVIDOR TCP PARA CENTRAIS DE ALARME IP ---
const tcpServer = net.createServer((socket) => {
  console.log('Central de alarme/eletrificador conectada via Socket IP');

  socket.on('data', async (data) => {
    const eventoTraduzido = decodificarContactID(data);
    
    try {
      await pool.query(`
        INSERT INTO logs_eventos (dispositivo_nome, tipo_dispositivo, fabricante, descricao_evento)
        VALUES ('Central IP Geral', 'ALARME', 'Multi-Fabricante', $1);
      `, [eventoTraduzido]);
      
      // Resposta ACK básica para a central não desconectar
      socket.write(Buffer.from([0x06]));
    } catch (err) {
      console.error("Erro ao registrar pacote Contact ID:", err);
    }
  });

  socket.on('error', (err) => {
    console.log('Conexão com central de alarme encerrada com aviso');
  });
});

tcpServer.listen(tcpPort, () => {
  console.log(`Receptor Contact ID / SIA escutando na porta TCP ${tcpPort}`);
});

// --- ROTAS DA API REST ---

app.get('/api/status', (req, res) => {
  res.json({ system: "GM TECH Access API", status: "Online", database: "PostgreSQL Conectado" });
});

// CFTV
app.get('/api/cftv/cameras', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cftv_cameras ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar câmeras" });
  }
});

app.post('/api/cftv/cameras', async (req, res) => {
  const { nome, fabricante, ip, porta_onvif, usuario, senha, canal } = req.body;
  let rtsp_url = "";
  const ch = canal || 1;

  if (fabricante.toLowerCase().includes("intelbras") || fabricante.toLowerCase().includes("dahua")) {
    rtsp_url = `rtsp://${usuario}:${senha}@${ip}:554/cam/realmonitor?channel=${ch}&subtype=0`;
  } else if (fabricante.toLowerCase().includes("hikvision")) {
    rtsp_url = `rtsp://${usuario}:${senha}@${ip}:554/Streaming/Channels/${ch}01`;
  } else {
    rtsp_url = `rtsp://${usuario}:${senha}@${ip}:554/live/ch${ch}`;
  }

  try {
    const query = `
      INSERT INTO cftv_cameras (nome, fabricante, ip, porta_onvif, usuario, senha, rtsp_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;
    `;
    const result = await pool.query(query, [nome, fabricante, ip, porta_onvif || 80, usuario, senha, rtsp_url]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao salvar câmera" });
  }
});

// EVENTOS
app.get('/api/eventos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM logs_eventos ORDER BY recebido_em DESC LIMIT 20');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar eventos" });
  }
});

app.post('/api/eventos', async (req, res) => {
  const { dispositivo, tipo, fabricante, evento, status } = req.body;
  try {
    const query = `
      INSERT INTO logs_eventos (dispositivo_nome, tipo_dispositivo, fabricante, descricao_evento, status_evento)
      VALUES ($1, $2, $3, $4, $5) RETURNING *;
    `;
    const result = await pool.query(query, [dispositivo, tipo, fabricante, evento, status || 'SUCESSO']);
    res.status(201).json({ message: "Evento registrado", dados: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: "Erro ao registrar evento" });
  }
});

app.listen(port, () => {
  console.log(`Servidor HTTP rodando na porta ${port}`);
});
