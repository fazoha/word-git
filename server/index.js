import http from 'http'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import path from 'path'
import { config } from 'dotenv'
import { Server } from 'socket.io'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '..', '.env') })

const PORT = Number(process.env.PORT) || 3030
const MAX_MEMBERS = 3
const OPENAI_KEY = process.env.OPENAI_API_KEY
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const MAX_SECTION_CHARS = 28_000

/** @typedef {{ socketId: string, displayName: string, role: 'owner' | 'editor' }} Member */
/** @typedef {{ id: string, fromSocketId: string, fromName: string, workspaceId: string, submittedAt: string, workingDocument: object }} PendingReview */

/** @type {Map<string, { id: string, official: object, ownerSocketId: string, members: Member[], pendingReviews: PendingReview[] }>} */
const rooms = new Map()

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

function publicMembers(room) {
  return room.members.map((m) => ({
    id: m.socketId,
    name: m.displayName,
    role: m.role,
  }))
}

function cloneDoc(obj) {
  return JSON.parse(JSON.stringify(obj))
}

function snapshot(room) {
  return {
    official: room.official,
    pendingReviews: room.pendingReviews,
    members: publicMembers(room),
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function corsHeaders(req) {
  const origin = req.headers.origin
  const h = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin
    h['Access-Control-Allow-Credentials'] = 'true'
  } else {
    h['Access-Control-Allow-Origin'] = '*'
  }
  return h
}

async function handleCoauthor(req, res) {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(req) }

  if (!OPENAI_KEY?.trim()) {
    res.writeHead(503, headers)
    res.end(
      JSON.stringify({
        error: 'Server missing OPENAI_API_KEY. Add it to the project .env and restart npm run collab.',
      }),
    )
    return
  }

  let body
  try {
    const raw = await readBody(req)
    body = JSON.parse(raw || '{}')
  } catch {
    res.writeHead(400, headers)
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const excerpt = body.excerpt === true
  let text = typeof body.body === 'string' ? body.body : ''
  if (!text.trim()) {
    res.writeHead(400, headers)
    res.end(JSON.stringify({ error: 'Missing body text' }))
    return
  }
  let truncated = false
  if (text.length > MAX_SECTION_CHARS) {
    text = text.slice(0, MAX_SECTION_CHARS)
    truncated = true
  }

  const userContent = excerpt
    ? `Contract section (for context): "${title || '(untitled)'}"

The user highlighted ONLY this excerpt. Analyze **only** this passage — do not infer missing surrounding text:
"""${text}"""${truncated ? '\n\n(Note: excerpt was truncated for this request.)' : ''}`
    : `Section title: ${title || '(untitled)'}\n\nClause text:\n"""${text}"""${truncated ? '\n\n(Note: text was truncated for this request.)' : ''}`

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_KEY.trim()}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.35,
      max_tokens: 1200,
      messages: [
        {
          role: 'system',
          content:
            'You are Co-Author, a careful contract-review assistant. Read the clause and respond in Markdown with exactly two sections:\n\n## Issues\n- Bullet list of potential problems, ambiguous language, imbalance, or missing protections. If none stand out, say: - None significant for a quick pass.\n\n## Suggestions\n- Bullet list of concrete, actionable edits or negotiation points.\n\nBe concise. Output Markdown only. This is not legal advice.',
        },
        { role: 'user', content: userContent },
      ],
    }),
  })

  const data = await openaiRes.json().catch(() => ({}))
  if (!openaiRes.ok) {
    const msg = data?.error?.message || openaiRes.statusText || 'OpenAI request failed'
    res.writeHead(openaiRes.status >= 400 && openaiRes.status < 600 ? openaiRes.status : 502, headers)
    res.end(JSON.stringify({ error: msg }))
    return
  }

  const reply = data?.choices?.[0]?.message?.content?.trim()
  if (!reply) {
    res.writeHead(502, headers)
    res.end(JSON.stringify({ error: 'Empty response from model' }))
    return
  }

  res.writeHead(200, headers)
  res.end(JSON.stringify({ markdown: reply, model: OPENAI_MODEL, truncated }))
}

async function handleHttp(req, res) {
  const url = req.url?.split('?')[0] || ''

  if (req.method === 'OPTIONS' && url === '/api/coauthor') {
    res.writeHead(204, corsHeaders(req))
    res.end()
    return
  }

  if (req.method === 'POST' && url === '/api/coauthor') {
    try {
      await handleCoauthor(req, res)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Co-Author request failed'
      res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders(req) })
      res.end(JSON.stringify({ error: msg }))
    }
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Spellbook collaboration server')
}

const httpServer = http.createServer((req, res) => {
  void handleHttp(req, res)
})

const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
})

io.on('connection', (socket) => {
  socket.on('create_room', ({ displayName, official }) => {
    if (!displayName || typeof displayName !== 'string') {
      socket.emit('room_error', { message: 'Enter your name' })
      return
    }
    if (!official?.workspaceId) {
      socket.emit('room_error', { message: 'Invalid document' })
      return
    }
    let roomId = genRoomCode()
    while (rooms.has(roomId)) roomId = genRoomCode()

    const room = {
      id: roomId,
      official: cloneDoc(official),
      ownerSocketId: socket.id,
      members: [{ socketId: socket.id, displayName: displayName.trim().slice(0, 60), role: 'owner' }],
      pendingReviews: [],
    }
    rooms.set(roomId, room)
    socket.join(roomId)
    socket.data.roomId = roomId
    socket.data.role = 'owner'

    socket.emit('room_created', {
      roomId,
      role: 'owner',
      ...snapshot(room),
    })
  })

  socket.on('join_room', ({ roomId: rawCode, displayName }) => {
    const roomId = String(rawCode ?? '')
      .trim()
      .toUpperCase()
    if (!displayName || typeof displayName !== 'string') {
      socket.emit('room_error', { message: 'Enter your name' })
      return
    }
    const room = rooms.get(roomId)
    if (!room) {
      socket.emit('room_error', { message: 'Unknown room code' })
      return
    }
    if (room.members.length >= MAX_MEMBERS) {
      socket.emit('room_error', { message: 'Room is full (max 3 people for this MVP)' })
      return
    }
    if (room.members.some((m) => m.socketId === socket.id)) return

    room.members.push({
      socketId: socket.id,
      displayName: displayName.trim().slice(0, 60),
      role: 'editor',
    })
    socket.join(roomId)
    socket.data.roomId = roomId
    socket.data.role = 'editor'

    socket.emit('room_joined', {
      roomId,
      role: 'editor',
      ...snapshot(room),
    })
    io.to(roomId).emit('room_snapshot', snapshot(room))
  })

  socket.on('official_push', ({ official }) => {
    const roomId = socket.data.roomId
    const room = roomId ? rooms.get(roomId) : null
    if (!room || socket.id !== room.ownerSocketId) return
    if (!official?.workspaceId) return
    room.official = cloneDoc(official)
    socket.to(roomId).emit('official_updated', { official: room.official })
  })

  socket.on('submit_collab_review', ({ workspaceId, workingDocument }) => {
    const roomId = socket.data.roomId
    const room = roomId ? rooms.get(roomId) : null
    if (!room || socket.id === room.ownerSocketId) return
    if (!workspaceId || !workingDocument?.sections) return

    const member = room.members.find((m) => m.socketId === socket.id)
    if (!member) return

    const review = {
      id: randomUUID(),
      fromSocketId: socket.id,
      fromName: member.displayName,
      workspaceId,
      submittedAt: new Date().toISOString(),
      workingDocument: cloneDoc(workingDocument),
    }
    room.pendingReviews = room.pendingReviews.filter(
      (r) => !(r.fromSocketId === socket.id && r.workspaceId === workspaceId),
    )
    room.pendingReviews.push(review)
    io.to(roomId).emit('pending_reviews', { reviews: room.pendingReviews })
  })

  socket.on('owner_resolve_review', ({ reviewId, mergedOfficial }) => {
    const roomId = socket.data.roomId
    const room = roomId ? rooms.get(roomId) : null
    if (!room || socket.id !== room.ownerSocketId) return
    room.pendingReviews = room.pendingReviews.filter((r) => r.id !== reviewId)
    if (mergedOfficial?.workspaceId) {
      room.official = cloneDoc(mergedOfficial)
    }
    io.to(roomId).emit('room_snapshot', snapshot(room))
  })

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId
    if (!roomId) return
    const room = rooms.get(roomId)
    if (!room) return

    const wasOwner = socket.id === room.ownerSocketId
    room.members = room.members.filter((m) => m.socketId !== socket.id)
    room.pendingReviews = room.pendingReviews.filter((r) => r.fromSocketId !== socket.id)

    if (wasOwner || room.members.length === 0) {
      rooms.delete(roomId)
      io.to(roomId).emit('room_closed', { reason: wasOwner ? 'owner_left' : 'empty' })
      return
    }

    io.to(roomId).emit('room_snapshot', snapshot(room))
  })
})

httpServer.listen(PORT, () => {
  console.log(`[spellbook-collab] listening on :${PORT}`)
  if (!OPENAI_KEY?.trim()) {
    console.warn('[spellbook-collab] OPENAI_API_KEY missing — POST /api/coauthor will return 503')
  }
})
