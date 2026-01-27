import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const http = createServer(app);
app.use(cors());
app.use(express.json());

const io = new Server(http, {
  cors: { origin: '*' }
});

// ========== DADOS EM MEMÓRIA ==========
const users = new Map(); // id -> { name, coins, friends: Set<id> }
const rooms = new Map(); // roomId -> Room
const CATEGORIAS_POR_TEMA = {
  classico: ['Nome', 'Animal', 'Fruta', 'Objeto', 'Cor', 'Cidade', 'Profissão', 'Marca'],
  divertido: ['Personagem de desenho', 'Comida estranha', 'Palavra difícil', 'Nome de cachorro', 'Sobrenome', 'Bebida', 'País', 'Esporte'],
  geografia: ['País', 'Cidade', 'Rio', 'Montanha', 'Ilha', 'Capital', 'Estado brasileiro', 'Continente'],
  cultura: ['Filme', 'Série', 'Música', 'Artista', 'Livro', 'Jogo', 'YouTuber', 'Marca'],
  custom: [] // preenchido pelo criador da sala
};

const PONTOS = { invalido: 0, repetido: 5, soVoce: 10 };
const MOEDAS_VITORIA = 50;
const MOEDAS_PARTICIPACAO = 5;
const MOEDAS_ENTRADA_SALA = 10; // custo opcional em salas premium

const TEMPO_POR_MODO = { classico: 90, velocidade_maxima: 60, proxima_voce: 90, valendo_coca: 90, ficando_para_tras: 90 };

function createRoom(id, hostId, options = {}) {
  const modo = options.modo || 'classico';
  const categorias = (options.categorias && options.categorias.length > 0)
    ? options.categorias
    : [...(CATEGORIAS_POR_TEMA[options.tema] || CATEGORIAS_POR_TEMA.classico)];
  return {
    id,
    hostId,
    name: options.name || 'Sala Sem Nome',
    password: options.password || null,
    tema: options.tema || 'classico',
    modo,
    categorias,
    jogadores: new Map(),
    estado: 'aguardando',
    letra: null,
    tempoRestante: 0,
    timerRef: null,
    rodadaAtual: 0,
    maxRodadas: options.maxRodadas || 5,
    maxJogadores: Math.min(16, Math.max(2, options.maxJogadores || 8)),
    tempoRodada: TEMPO_POR_MODO[modo] ?? 90,
    aguardandoLetra: false,
    eliminados: [],
    createdAt: Date.now()
  };
}

function getOrCreateUser(userId, name) {
  if (!users.has(userId)) {
    users.set(userId, { name: name || 'Jogador', coins: 100, friends: new Set() });
  }
  return users.get(userId);
}

function nextLetter() {
  return String.fromCharCode(65 + Math.floor(Math.random() * 26));
}

// Timer da rodada (broadcast para sala)
function startRoundTimer(roomId, seconds, io, onEnd) {
  const room = rooms.get(roomId);
  if (!room || room.timerRef) return;
  room.tempoRestante = seconds;
  const tick = () => {
    room.tempoRestante--;
    io.to(roomId).emit('room:tempo', { tempo: room.tempoRestante });
    if (room.tempoRestante <= 0) {
      clearInterval(room.timerRef);
      room.timerRef = null;
      onEnd();
    }
  };
  room.timerRef = setInterval(tick, 1000);
}

function comecaComLetra(resp, letra) {
  if (!resp || !letra) return false;
  return (resp.trim().toUpperCase()[0] || '') === String(letra).toUpperCase()[0];
}

function calcularPontos(jogadores, categorias, letra) {
  const letraUpper = String(letra || '').toUpperCase()[0] || '';
  const contagem = {};
  for (const [, data] of jogadores) {
    const jid = data.userId;
    for (const [cat, resp] of Object.entries(data.respostas || {})) {
      if (!comecaComLetra(resp, letraUpper)) continue;
      const key = `${cat}:${(resp || '').trim().toLowerCase()}`;
      if (!contagem[key]) contagem[key] = new Set();
      if (resp && resp.trim()) contagem[key].add(jid);
    }
  }
  const pontosPorJogador = {};
  for (const [, data] of jogadores) {
    const jid = data.userId;
    pontosPorJogador[jid] = { total: 0, detalhe: {} };
    for (const cat of categorias) {
      const resp = (data.respostas && data.respostas[cat]) || '';
      let pts = PONTOS.invalido;
      if (resp && resp.trim()) {
        if (!comecaComLetra(resp, letraUpper)) {
          pts = PONTOS.invalido;
        } else {
          const key = `${cat}:${(resp || '').trim().toLowerCase()}`;
          const quem = contagem[key];
          if (!quem || quem.size === 0) pts = PONTOS.invalido;
          else if (quem.size === 1) pts = PONTOS.soVoce;
          else pts = PONTOS.repetido;
        }
      }
      pontosPorJogador[jid].total += pts;
      pontosPorJogador[jid].detalhe[cat] = pts;
    }
  }
  return pontosPorJogador;
}

// ========== HTTP (ranking, amigos, salas públicas) ==========
app.get('/api/ranking', (req, res) => {
  const list = [...users.entries()]
    .map(([id, u]) => ({ userId: id, name: u.name, coins: u.coins }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 100);
  res.json(list);
});

app.get('/api/user/:id', (req, res) => {
  const u = users.get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json({
    userId: req.params.id,
    name: u.name,
    coins: u.coins,
    friends: [...u.friends]
  });
});

app.post('/api/user', (req, res) => {
  const { userId, name } = req.body || {};
  const id = userId || uuidv4();
  getOrCreateUser(id, name);
  res.json({ userId: id, name: users.get(id).name, coins: users.get(id).coins });
});

app.post('/api/friends/add', (req, res) => {
  const { userId, friendId } = req.body || {};
  if (!userId || !friendId) return res.status(400).json({ error: 'userId e friendId obrigatórios' });
  const u = getOrCreateUser(userId);
  u.friends.add(friendId);
  const f = getOrCreateUser(friendId);
  f.friends.add(userId);
  res.json({ friends: [...u.friends] });
});

app.get('/api/ranking/amigos/:userId', (req, res) => {
  const u = users.get(req.params.userId);
  if (!u) return res.json([]);
  const list = [...u.friends]
    .map(id => ({ userId: id, ...users.get(id) }))
    .filter(Boolean)
    .map(({ userId, name, coins }) => ({ userId, name, coins }))
    .sort((a, b) => b.coins - a.coins);
  res.json(list);
});

app.get('/api/salas', (req, res) => {
  const lista = [];
  for (const [id, r] of rooms.entries()) {
    if (r.estado !== 'aguardando') continue;
    if (r.password) continue; // não listar salas com senha na lista pública
    lista.push({
      id,
      name: r.name,
      tema: r.tema,
      jogadores: r.jogadores.size,
      maxJogadores: 8,
      temSenha: !!r.password
    });
  }
  res.json(lista);
});

// ========== SOCKET.IO ==========
io.on('connection', (socket) => {
  socket.on('user:identify', ({ userId, name }) => {
    const u = getOrCreateUser(userId, name);
    socket.userId = userId;
    socket.userName = u.name;
    socket.emit('user:ok', { userId, name: u.name, coins: u.coins });
  });

  socket.on('room:create', ({ name, password, tema, categorias, maxRodadas, maxJogadores, modo }) => {
    const roomId = uuidv4().slice(0, 8);
    const hostId = socket.userId || uuidv4();
    getOrCreateUser(hostId, socket.userName);
    const room = createRoom(roomId, hostId, {
      name: name || 'Nova Sala',
      password: password || null,
      tema: tema || 'classico',
      categorias: categorias && categorias.length ? categorias : null,
      maxRodadas: maxRodadas || 5,
      maxJogadores: maxJogadores || 8,
      modo: modo || 'classico'
    });
    room.jogadores.set(socket.id, {
      userId: hostId,
      name: socket.userName || 'Host',
      pontos: 0,
      respostas: {}
    });
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.roomId = roomId;
    socket.emit('room:joined', {
      roomId,
      host: true,
      categorias: room.categorias,
      tema: room.tema,
      modo: room.modo,
      maxJogadores: room.maxJogadores,
      jogadores: [...room.jogadores.entries()].map(([sid, j]) => ({ socketId: sid, name: j.name, userId: j.userId }))
    });
    io.to(roomId).emit('room:players', {
      jogadores: [...room.jogadores.entries()].map(([sid, j]) => ({ socketId: sid, name: j.name, userId: j.userId, pontos: j.pontos }))
    });
  });

  socket.on('room:join', ({ roomId, password }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('room:error', { message: 'Sala não existe' });
    if (room.estado !== 'aguardando') return socket.emit('room:error', { message: 'Partida já iniciada' });
    if (room.password && room.password !== (password || '')) return socket.emit('room:error', { message: 'Senha incorreta' });
    if (room.jogadores.size >= room.maxJogadores) return socket.emit('room:error', { message: 'Sala cheia' });

    const uid = socket.userId || uuidv4();
    const name = socket.userName || 'Jogador';
    getOrCreateUser(uid, name);
    room.jogadores.set(socket.id, { userId: uid, name, pontos: 0, respostas: {} });
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit('room:joined', {
      roomId,
      host: room.hostId === uid,
      categorias: room.categorias,
      tema: room.tema,
      modo: room.modo,
      maxJogadores: room.maxJogadores,
      jogadores: [...room.jogadores.entries()].map(([sid, j]) => ({ socketId: sid, name: j.name, userId: j.userId }))
    });
    io.to(roomId).emit('room:players', {
      jogadores: [...room.jogadores.entries()].map(([sid, j]) => ({ socketId: sid, name: j.name, userId: j.userId, pontos: j.pontos }))
    });
  });

  socket.on('room:list', (cb) => {
    const lista = [];
    for (const [id, r] of rooms.entries()) {
      if (r.estado !== 'aguardando') continue;
      lista.push({
        id,
        name: r.name,
        tema: r.tema,
        modo: r.modo,
        jogadores: r.jogadores.size,
        maxJogadores: r.maxJogadores,
        temSenha: !!r.password
      });
    }
    cb(lista);
  });

  socket.on('room:start', () => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room || room.hostId !== socket.userId) return;
    if (room.jogadores.size < 2) return socket.emit('room:error', { message: 'Precisa de pelo menos 2 jogadores' });
    room.estado = 'rodando';
    room.rodadaAtual = 1;
    for (const j of room.jogadores.values()) j.respostas = {};
    if (room.modo === 'proxima_voce') {
      room.aguardandoLetra = true;
      const ordem = [...room.jogadores.keys()];
      const idx = (room.rodadaAtual - 1) % ordem.length;
      room.escolhedorSocketId = ordem[idx];
      const escolhedor = room.jogadores.get(room.escolhedorSocketId);
      io.to(roomId).emit('game:escolher_letra', {
        escolhedor: room.escolhedorSocketId,
        escolhedorNome: escolhedor?.name,
        categorias: room.categorias,
        rodada: 1,
        modo: room.modo,
        tempoRodada: room.tempoRodada
      });
    } else {
      const letra = nextLetter();
      room.letra = letra;
      io.to(roomId).emit('game:start', { letra, categorias: room.categorias, rodada: 1, modo: room.modo, tempoRodada: room.tempoRodada });
      startRoundTimer(roomId, room.tempoRodada, io, () => roundEnd(roomId, io));
    }
  });

  socket.on('game:letra_escolhida', ({ letra }) => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room || room.modo !== 'proxima_voce' || !room.aguardandoLetra) return;
    if (room.escolhedorSocketId !== socket.id) return socket.emit('room:error', { message: 'Não é sua vez de escolher' });
    const L = (String(letra || '').toUpperCase().replace(/[^A-Z]/g, ''))[0];
    if (!L) return socket.emit('room:error', { message: 'Escolha uma letra de A a Z' });
    room.letra = L;
    room.aguardandoLetra = false;
    io.to(roomId).emit('game:letra_definida', { letra: L, categorias: room.categorias, rodada: room.rodadaAtual, tempoRodada: room.tempoRodada });
    startRoundTimer(roomId, room.tempoRodada, io, () => roundEnd(roomId, io));
  });

  socket.on('game:respostas', (respostas) => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.jogadores.has(socket.id)) return;
    room.jogadores.get(socket.id).respostas = respostas || {};
    socket.emit('game:respostas:ok');
    const total = room.jogadores.size;
    const prontos = [...room.jogadores.values()].filter((j) => Object.keys(j.respostas || {}).length > 0).length;
    const minimo = Math.ceil(total / 2);
    io.to(roomId).emit('room:prontos', { prontos, total, minimo, podeStop: prontos >= minimo });
  });

  socket.on('game:stop', () => {
    const roomId = socket.roomId;
    const room = rooms.get(roomId);
    if (!room || room.estado !== 'rodando' || !room.timerRef) return;
    const total = room.jogadores.size;
    const minimo = Math.ceil(total / 2);
    const prontos = [...room.jogadores.values()].filter((j) => Object.keys(j.respostas || {}).length > 0).length;
    const euEnviei = Object.keys(room.jogadores.get(socket.id)?.respostas || {}).length > 0;
    if (!euEnviei) {
      socket.emit('room:error', { message: 'Clique em Pronto antes de dar STOP.' });
      return;
    }
    if (prontos < minimo) {
      socket.emit('room:error', { message: `Pelo menos ${minimo} de ${total} jogadores precisam terminar para dar STOP.` });
      return;
    }
    clearInterval(room.timerRef);
    room.timerRef = null;
    room.tempoRestante = 0;
    roundEnd(roomId, io);
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.jogadores.delete(socket.id);
        io.to(roomId).emit('room:players', {
          jogadores: [...room.jogadores.entries()].map(([sid, j]) => ({ socketId: sid, name: j.name, userId: j.userId, pontos: j.pontos }))
        });
        if (room.jogadores.size === 0) rooms.delete(roomId);
        else if (room.hostId === socket.userId) {
          const primeiro = room.jogadores.values().next().value;
          if (primeiro) room.hostId = primeiro.userId;
        }
      }
    }
  });
});

function roundEnd(roomId, io) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.estado = 'resultado';
  const jogadores = [...room.jogadores.entries()];
  const pts = calcularPontos(jogadores, room.categorias, room.letra);
  const bySocket = {};
  const respostasPorJogador = {};
  for (const [sid, j] of jogadores) {
    const pd = pts[j.userId] || { total: 0, detalhe: {} };
    j.pontos += pd.total;
    bySocket[sid] = { total: pd.total, detalhe: pd.detalhe, acumulado: j.pontos };
    respostasPorJogador[sid] = { name: j.name, userId: j.userId, respostas: j.respostas || {} };
  }
  const eliminadosEstaRodada = [];
  if (room.modo === 'ficando_para_tras' && room.eliminados) {
    const jogadoresAtual = [...room.jogadores.entries()];
    if (jogadoresAtual.length > 1) {
      const minP = Math.min(...jogadoresAtual.map(([, j]) => j.pontos));
      const toRemove = jogadoresAtual.filter(([, j]) => j.pontos === minP);
      for (const [sid, j] of toRemove) {
        room.eliminados.push({ userId: j.userId, name: j.name, pontos: j.pontos });
        eliminadosEstaRodada.push({ userId: j.userId, name: j.name, pontos: j.pontos });
        room.jogadores.delete(sid);
      }
    }
  }

  io.to(roomId).emit('game:resultado', {
    letra: room.letra,
    categorias: room.categorias,
    pontuacao: bySocket,
    respostasPorJogador,
    jogadores: [...room.jogadores.entries()].map(([sid, j]) => ({ socketId: sid, name: j.name, userId: j.userId, pontos: j.pontos })),
    eliminadosEstaRodada: room.modo === 'ficando_para_tras' ? eliminadosEstaRodada : undefined,
    modo: room.modo
  });

  setTimeout(() => {
    if (!rooms.has(roomId)) return;
    const r = rooms.get(roomId);

    if (r.modo === 'ficando_para_tras' && r.jogadores.size <= 1) {
      const winner = r.jogadores.values().next().value;
      const ranking = winner
        ? [{ userId: winner.userId, name: winner.name, pontos: winner.pontos }]
        : [];
      const rankReversed = [...(r.eliminados || [])].reverse();
      ranking.push(...rankReversed.map((e) => ({ userId: e.userId, name: e.name, pontos: e.pontos })));
      if (winner) {
        const u = users.get(winner.userId);
        if (u) u.coins += MOEDAS_VITORIA;
        rankReversed.forEach((j) => {
          const uu = users.get(j.userId);
          if (uu) uu.coins += MOEDAS_PARTICIPACAO;
        });
      }
      io.to(roomId).emit('game:fim', { ranking, modo: r.modo });
      rooms.delete(roomId);
      return;
    }

    if (r.rodadaAtual >= r.maxRodadas) {
      const ranking = [...r.jogadores.entries()]
        .map(([sid, j]) => ({ userId: j.userId, name: j.name, pontos: j.pontos }))
        .sort((a, b) => b.pontos - a.pontos);
      const vencedor = ranking[0];
      if (vencedor) {
        const u = users.get(vencedor.userId);
        if (u) {
          u.coins += MOEDAS_VITORIA;
          ranking.forEach((j, i) => {
            if (i > 0) {
              const uu = users.get(j.userId);
              if (uu) uu.coins += MOEDAS_PARTICIPACAO;
            }
          });
        }
      }
      io.to(roomId).emit('game:fim', { ranking, modo: r.modo });
      rooms.delete(roomId);
      return;
    }
    r.estado = 'rodando';
    r.rodadaAtual++;
    for (const j of r.jogadores.values()) j.respostas = {};
    if (r.modo === 'proxima_voce') {
      r.aguardandoLetra = true;
      const ordem = [...r.jogadores.keys()];
      const idx = (r.rodadaAtual - 1) % ordem.length;
      r.escolhedorSocketId = ordem[idx];
      const escolhedor = r.jogadores.get(r.escolhedorSocketId);
      io.to(roomId).emit('game:escolher_letra', {
        escolhedor: r.escolhedorSocketId,
        escolhedorNome: escolhedor?.name,
        categorias: r.categorias,
        rodada: r.rodadaAtual,
        modo: r.modo,
        tempoRodada: r.tempoRodada
      });
    } else {
      r.letra = nextLetter();
      io.to(roomId).emit('game:proxima', { letra: r.letra, rodada: r.rodadaAtual, categorias: r.categorias, modo: r.modo, tempoRodada: r.tempoRodada });
      startRoundTimer(roomId, r.tempoRodada, io, () => roundEnd(roomId, io));
    }
  }, 8000);
}

const PORT = process.env.PORT || 3001;
http.listen(PORT, () => console.log(`Adedonha server :${PORT}`));
