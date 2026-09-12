const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Conexão com o PostgreSQL do Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Função para criar as tabelas no banco automaticamente
const initDb = async () => {
  try {
    // Tabela de Dispositivos (DVR, Alarme, Controle de Acesso, Cerca)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dispositivos (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        tipo VARCHAR(50) NOT NULL,
        fabricante VARCHAR(50) NOT NULL,
        ip_host VARCHAR(100),
        status VARCHAR(20) DEFAULT 'ONLINE',
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabela de Logs de Eventos do Sistema
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

    console.log("Tabelas 'dispositivos' e 'logs_eventos' criadas/verificadas com sucesso!");
  } catch (err) {
    console.error("Erro ao inicializar tabelas no PostgreSQL:", err);
  }
};

// Executa a criação das tabelas ao iniciar
initDb();

// Rota de teste de status
app.get('/api/status', (req, res) => {
  res.json({
    system: "GM TECH Access API",
    status: "Online",
    database: "Conectado ao PostgreSQL"
  });
});

// Rota para listar os últimos eventos salvos no banco
app.get('/api/eventos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM logs_eventos ORDER BY recebido_em DESC LIMIT 20');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar eventos do banco" });
  }
});

// Rota para receber novos eventos de equipamentos e salvar no banco
app.post('/api/eventos', async (req, res) => {
  const { dispositivo, tipo, fabricante, evento, status } = req.body;
  
  try {
    const query = `
      INSERT INTO logs_eventos (dispositivo_nome, tipo_dispositivo, fabricante, descricao_evento, status_evento)
      VALUES ($1, $2, $3, $4, $5) RETURNING *;
    `;
    const values = [dispositivo, tipo, fabricante, evento, status || 'SUCESSO'];
    const result = await pool.query(query, values);

    res.status(201).json({
      message: "Evento salvo no banco de dados com sucesso!",
      dados: result.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erro ao salvar evento no banco" });
  }
});

app.listen(port, () => {
  console.log(`Servidor GM TECH Access rodando na porta ${port}`);
});
