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

// Rota de teste da API
app.get('/api/status', (req, res) => {
  res.json({
    system: "GM TECH Access API",
    status: "Online",
    timestamp: new Date()
  });
});

// Rota para receber eventos (DVR, Alarme, Controle de Acesso)
app.post('/api/eventos', async (req, res) => {
  const { dispositivo, fabricante, evento, tipo } = req.body;
  
  try {
    res.status(201).json({
      message: "Evento recebido com sucesso",
      dados: { dispositivo, fabricante, evento, tipo, data: new Date() }
    });
  } catch (error) {
    res.status(500).json({ error: "Erro ao processar evento" });
  }
});

app.listen(port, () => {
  console.log(`Servidor GM TECH Access rodando na porta ${port}`);
});
