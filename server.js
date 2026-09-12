const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const net = require('net');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const tcpPort = process.env.TCP_PORT || 10001;
const JWT_SECRET = process.env.JWT_SECRET || 'gmtech_chave_secreta_acesso_2026';

app.use(cors());
app.use(express.json());

// Conexão PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware de Autenticação JWT
const verificarToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ error: "Acesso negado. Token não fornecido." });

  try {
    const bearerToken = token.startsWith('Bearer ') ? token.slice(7) : token;
    const verificado = jwt.verify(bearerToken, JWT_SECRET);
    req.usuario = verificado;
    next();
  } catch (err) {
    res.status(400).json({ error: "Token inválido ou expirado." });
  }
};

// Inicialização do Banco
const initDb = async () => {
  try {
    // Tabela de Operadores do Sistema
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sistema_operadores (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        senha VARCHAR(255) NOT NULL,
        perfil VARCHAR(20) DEFAULT 'OPERADOR', -- ADMIN, OPERADOR, PORTARIA
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Criar Usuário Admin Padrão se não existir
    const resAdmin = await pool.query('SELECT * FROM sistema_operadores WHERE email = $1', ['admin@gmtech.com']);
    if (resAdmin.rows.length === 0) {
      const hashSenha = await bcrypt.hash('admin123', 10);
      await pool.query(`
        INSERT INTO sistema_operadores (nome, email, senha, perfil)
        VALUES ('Administrador Master', 'admin@gmtech.com', $1, 'ADMIN');
      `, [hashSenha]);
      console.log("Usuário Admin padrão criado com sucesso! (admin@gmtech.com / admin123)");
    }

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
        tipo_permissao VARCHAR(30) DEFAULT 'MORADOR',
        status VARCHAR(20) DEFAULT 'ATIVO',
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

    console.log("Banco de dados sincronizado com tabela de Operadores e JWT!");
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

// --- ROTAS DE AUTENTICAÇÃO ---

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  try {
    const result = await pool.query('SELECT * FROM sistema_operadores WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "E-mail ou senha incorretos." });
    }

    const operador = result.rows[0];
    const senhaValida = await bcrypt.compare(senha, operador.senha);
    if (!senhaValida) {
      return res.status(400).json({ error: "E-mail ou senha incorretos." });
    }

    const token = jwt.sign(
      { id: operador.id, nome: operador.nome, perfil: operador.perfil },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      message: "Login realizado com sucesso",
      token,
      operador: { nome: operador.nome, email: operador.email, perfil: operador.perfil }
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao realizar login" });
  }
});

// --- ROTAS DA API PROTEGIDAS ---

app.get('/api/status', (req, res) => {
  res.json({ system: "GM TECH Access API", status: "Online", database: "PostgreSQL Conectado" });
});

// CFTV
app.get('/api/cftv/cameras', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cftv_cameras ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar câmeras" });
  }
});

app.post('/api/cftv/cameras', verificarToken, async (req, res) => {
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
app.get('/api/acesso/usuarios', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM acesso_usuarios ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar usuários" });
  }
});

app.post('/api/acesso/usuarios', verificarToken, async (req, res) => {
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
app.post('/api/acesso/acionar', verificarToken, async (req, res) => {
  const { dispositivo, fabricante, acao } = req.body;
  try {
    await pool.query(`
      INSERT INTO logs_eventos (dispositivo_nome, tipo_dispositivo, fabricante, descricao_evento, status_evento)
      VALUES ($1, 'ACESSO', $2, $3, 'SUCESSO');
    `, [dispositivo, fabricante, `Comando Remoto [por ${req.usuario.nome}]: ${acao}`]);

    res.json({ success: true, message: `Comando '${acao}' enviado com sucesso!` });
  } catch (err) {
    res.status(500).json({ error: "Erro ao enviar comando remoto" });
  }
});

// EVENTOS
app.get('/api/eventos', verificarToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM logs_eventos ORDER BY recebido_em DESC LIMIT 20');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar eventos" });
  }
});

app.post('/api/eventos', verificarToken, async (req, res) => {
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
