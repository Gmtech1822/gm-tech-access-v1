const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const net = require('net');

const app = express();
const port = process.env.PORT || 3000;
const tcpPort = process.env.TCP_PORT || 10001;

app.use(cors());
app.use(express.json());

// Conexão PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicialização do Banco
const initDb = async () => {
  try {
    // Tabela CFTV
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

    // Tabela Usuários de Controle de Acesso
    await pool.query(`
      CREATE TABLE IF NOT EXISTS acesso_usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        documento VARCHAR(30),
        cartao_tag VARCHAR(50),
        tipo_permissao VARCHAR(30) DEFAULT 'MORADOR', -- MORADOR, VISITANTE, PRESTADOR
        status VARCHAR(20) DEFAULT 'ATIVO',
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabela Dispositivos de Acesso (Catracas, Cancelas, Leitoras)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS acesso_dispositivos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        tipo VARCHAR(50) NOT NULL, -- CATRACA, PORTA, CANCELA
        fabricante VARCHAR(50) NOT NULL, -- CONTROL ID, INTELBRAS, HIKVISION
        ip VARCHAR(45),
        status VARCHAR(20) DEFAULT 'ONLINE',
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabela Logs de Eventos
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

    console.log("Banco de dados sincronizado com tabelas de CFTV, Alarmes e Controle de Acesso!");
  } catch (err) {
    console.error("Erro ao inicializar banco:", err);
  }
};

initDb();

// --- DECODER CONTACT ID ---
function decodificarContactID(rawBuffer) {
  const rawMsg = rawBuffer.toString('ascii');
  const codigos = {
    '1130': 'Disparo de Alarme - Conflito/Zona',
    '1134': 'Disparo - Invasão de Perímetro',
    '1381': 'Perda de Pulso - Cerca Elétrica',
    '1401': 'Desarme pelo Usuário',
    '3401': 'Arme pelo Usuário',
    '1120': 'Pânico Silencioso'
  };

  for (let code in codigos) {
    if (rawMsg.includes(code)) return codigos[code];
  }
  return `Evento Contact ID Recebido: ${rawMsg.substring(0, 30)}`;
}

// Servidor TCP
const tcpServer = net.createServer((socket) => {
  socket.on('data', async (data) => {
    const eventoTraduzido = decodificarContactID(data);
    try {
      await pool.query(`
        INSERT INTO logs_eventos (dispositivo_nome, tipo_dispositivo, fabricante, descricao_evento)
        VALUES ('Central IP Geral', 'ALARME', 'Multi-Fabricante', $1);
      `, [eventoTraduzido]);
      socket.write(Buffer.from([0x06]));
    } catch (err) {
      console.error(err);
    }
  });
});
tcpServer.listen(tcpPort);

// --- ROTAS DA API ---

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
    const result = await pool.query(`
      INSERT INTO cftv_cameras (nome, fabricante, ip, porta_onvif, usuario, senha, rtsp_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;
    `, [nome, fabricante, ip, porta_onvif || 80, usuario, senha, rtsp_url]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao salvar câmera" });
  }
});

// CONTROLE DE ACESSO - USUÁRIOS
app.get('/api/acesso/usuarios', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM acesso_usuarios ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar usuários" });
  }
});

app.post('/api/acesso/usuarios', async (req, res) => {
  const { nome, documento, cartao_tag, tipo_permissao } = req.body;
  try {
    const result = await pool.query(`
      INSERT INTO acesso_usuarios (nome, documento, cartao_tag, tipo_permissao)
      VALUES ($1, $2, $3, $4) RETURNING *;
    `, [nome, documento, cartao_tag, tipo_permissao || 'MORADOR']);

    await pool.query(`
      INSERT INTO logs_eventos (dispositivo_nome, tipo_dispositivo, fabricante, descricao_evento)
      VALUES ('Servidor Acesso', 'ACESSO', 'GM TECH', $1);
    `, [`Novo Usuário Cadastrado: ${nome} (Tag: ${cartao_tag})`]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Erro ao cadastrar usuário" });
  }
});

// CONTROLE DE ACESSO - ACIONAMENTO REMOTO
app.post('/api/acesso/acionar', async (req, res) => {
  const { dispositivo, fabricante, acao } = req.body;
  try {
    await pool.query(`
      INSERT INTO logs_eventos (dispositivo_nome, tipo_dispositivo, fabricante, descricao_evento, status_evento)
      VALUES ($1, 'ACESSO', $2, $3, 'SUCESSO');
    `, [dispositivo, fabricante, `Comando Remoto: ${acao}`]);

    res.json({ success: true, message: `Comando '${acao}' enviado com sucesso!` });
  } catch (err) {
    res.status(500).json({ error: "Erro ao enviar comando remoto" });
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
    const result = await pool.query(`
      INSERT INTO logs_eventos (dispositivo_nome, tipo_dispositivo, fabricante, descricao_evento, status_evento)
      VALUES ($1, $2, $3, $4, $5) RETURNING *;
    `, [dispositivo, tipo, fabricante, evento, status || 'SUCESSO']);
    res.status(201).json({ message: "Evento registrado", dados: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: "Erro ao registrar evento" });
  }
});

app.listen(port, () => {
  console.log(`Servidor HTTP rodando na porta ${port}`);
});
    
