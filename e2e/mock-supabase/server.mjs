// ============================================================================
// TEST-ONLY Supabase emulator for end-to-end tests.
//
// Implements the subset of the Supabase Auth (GoTrue), REST (PostgREST) and
// Edge Functions HTTP APIs that INVPORTIQ uses. Every REST request runs
// against a real PostgreSQL database containing the real migrations, as the
// `anon` / `authenticated` / `service_role` role with JWT claims — so RLS,
// grants, triggers and RPC role checks are exercised exactly as in Supabase.
// The real Edge Function source files are executed in-process.
//
// Never use in production. Start: node e2e/mock-supabase/server.mjs
// ============================================================================
import http from 'node:http';
import crypto from 'node:crypto';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import pg from 'pg';

register(pathToFileURL(path.join(import.meta.dirname, 'loader.mjs')));

const PORT = Number(process.env.MOCK_PORT ?? 54400);
const BASE = `http://127.0.0.1:${PORT}`;
const ANON_KEY = 'e2e-anon-key';
const SERVICE_KEY = 'e2e-service-role-key';
const JWT_SECRET = 'e2e-jwt-secret-not-for-production';
const ACCESS_TTL = 1800;

// PostgREST returns int8/numeric as JSON numbers and dates as plain strings.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

const pool = new pg.Pool({
  host: process.env.PGHOST ?? '/tmp',
  port: Number(process.env.PGPORT ?? 54329),
  user: process.env.PGUSER ?? 'postgres',
  database: process.env.TEST_DB ?? 'invportiq_e2e',
  max: 10,
});

// ---------------------------------------------------------------------------
// Auth state (passwords hashed with scrypt, kept in memory for the test run)
// ---------------------------------------------------------------------------
const users = new Map(); // id -> { id, email, hash, salt, banned_until, user_metadata, created_at }
const refreshTokens = new Map(); // token -> { sessionId, userId }

// Credentials persist in the test database so the emulator can be restarted.
await pool.query(`create table if not exists auth.mock_credentials (
  id uuid primary key references auth.users (id) on delete cascade, data jsonb not null)`);
for (const row of (await pool.query('select data from auth.mock_credentials')).rows) users.set(row.data.id, row.data);
const saveUser = (u) =>
  pool.query('insert into auth.mock_credentials (id, data) values ($1, $2) on conflict (id) do update set data = excluded.data', [u.id, u]);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function signJwt(payload) {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token) {
  const [h, b, s] = String(token).split('.');
  if (!h || !b || !s) return null;
  const expect = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url');
  if (expect.length !== s.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(s))) return null;
  const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
  if (claims.exp && claims.exp < Date.now() / 1000) return null;
  return claims;
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

function userJson(u) {
  return {
    id: u.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: u.email,
    email_confirmed_at: u.created_at,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: u.user_metadata ?? {},
    identities: [],
    created_at: u.created_at,
    updated_at: new Date().toISOString(),
    banned_until: u.banned_until ?? null,
  };
}

async function createSession(u, method = 'password') {
  const sessionId = crypto.randomUUID();
  await pool.query('insert into auth.sessions (id, user_id) values ($1, $2)', [sessionId, u.id]);
  return issueTokens(u, sessionId, [{ method, timestamp: Math.floor(Date.now() / 1000) }]);
}
function issueTokens(u, sessionId, amr) {
  const now = Math.floor(Date.now() / 1000);
  const access = signJwt({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', session_id: sessionId, amr, iat: now, exp: now + ACCESS_TTL });
  const refresh = crypto.randomBytes(24).toString('hex');
  refreshTokens.set(refresh, { sessionId, userId: u.id, amr });
  return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL, expires_at: now + ACCESS_TTL, refresh_token: refresh, user: userJson(u) };
}
async function sessionAlive(sessionId) {
  const r = await pool.query('select 1 from auth.sessions where id = $1', [sessionId]);
  return r.rowCount > 0;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Range',
    ...headers,
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}
function bearer(req) {
  const h = req.headers.authorization ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7) : '';
}
const authError = (res, status, msg, code = 'invalid_credentials') => send(res, status, { code: status, error_code: code, msg, error: code, error_description: msg });

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------
async function handleAuth(req, res, url) {
  const p = url.pathname.replace('/auth/v1', '');
  const isService = bearer(req) === SERVICE_KEY || req.headers.apikey === SERVICE_KEY;

  if (p === '/token' && req.method === 'POST') {
    const body = await readBody(req);
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const u = [...users.values()].find((x) => x.email === String(body.email ?? '').toLowerCase());
      if (!u || hashPw(body.password ?? '', u.salt) !== u.hash) return authError(res, 400, 'Invalid login credentials');
      if (u.banned_until && new Date(u.banned_until) > new Date()) return authError(res, 400, 'User is banned', 'user_banned');
      return send(res, 200, await createSession(u));
    }
    if (grant === 'refresh_token') {
      const rt = refreshTokens.get(body.refresh_token);
      if (!rt || !(await sessionAlive(rt.sessionId))) return authError(res, 400, 'Invalid Refresh Token', 'refresh_token_not_found');
      refreshTokens.delete(body.refresh_token);
      const u = users.get(rt.userId);
      return send(res, 200, issueTokens(u, rt.sessionId, rt.amr));
    }
    return authError(res, 400, 'unsupported grant', 'validation_failed');
  }

  if (p === '/user' && req.method === 'GET') {
    const claims = verifyJwt(bearer(req));
    if (!claims || !users.has(claims.sub)) return authError(res, 401, 'invalid JWT', 'bad_jwt');
    if (claims.session_id && !(await sessionAlive(claims.session_id))) return authError(res, 403, 'Session not found', 'session_not_found');
    return send(res, 200, userJson(users.get(claims.sub)));
  }

  if (p === '/logout' && req.method === 'POST') {
    const claims = verifyJwt(bearer(req));
    if (claims?.session_id) await pool.query('delete from auth.sessions where id = $1', [claims.session_id]);
    return send(res, 204);
  }

  if (p === '/recover' && req.method === 'POST') return send(res, 200, {});

  if (p.startsWith('/admin/users')) {
    if (!isService) return authError(res, 403, 'service role required', 'not_admin');
    const id = p.split('/')[3];
    if (req.method === 'POST' && !id) {
      const body = await readBody(req);
      const email = String(body.email ?? '').toLowerCase();
      if ([...users.values()].some((u) => u.email === email)) return authError(res, 422, 'A user with this email address has already been registered', 'email_exists');
      if (String(body.password ?? '').length < 8) return authError(res, 422, 'Password should be at least 8 characters.', 'weak_password');
      const u = { id: crypto.randomUUID(), email, salt: crypto.randomBytes(8).toString('hex'), user_metadata: body.user_metadata ?? {}, created_at: new Date().toISOString() };
      u.hash = hashPw(body.password, u.salt);
      await pool.query('insert into auth.users (id, email) values ($1, $2)', [u.id, email]);
      users.set(u.id, u);
      await saveUser(u);
      return send(res, 200, userJson(u));
    }
    const u = users.get(id);
    if (!u) return authError(res, 404, 'User not found', 'user_not_found');
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (body.password) u.hash = hashPw(body.password, u.salt);
      if (body.ban_duration) u.banned_until = body.ban_duration === 'none' ? null : new Date(Date.now() + 100 * 365 * 864e5).toISOString();
      await saveUser(u);
      return send(res, 200, userJson(u));
    }
    if (req.method === 'DELETE') {
      await pool.query('delete from auth.users where id = $1', [id]);
      users.delete(id);
      return send(res, 200, {});
    }
  }
  return authError(res, 404, 'not found', 'not_found');
}

// ---------------------------------------------------------------------------
// REST API (PostgREST subset)
// ---------------------------------------------------------------------------
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!IDENT.test(s)) throw Object.assign(new Error(`invalid identifier ${s}`), { code: 'PGRST100', status: 400 });
  return `"${s}"`;
};

function roleFor(req) {
  const token = bearer(req);
  if (token === SERVICE_KEY) return { role: 'service_role', claims: { role: 'service_role' } };
  const claims = token && token !== ANON_KEY ? verifyJwt(token) : null;
  if (token && token !== ANON_KEY && !claims) return { error: true };
  if (claims) return { role: 'authenticated', claims };
  return { role: 'anon', claims: { role: 'anon' } };
}

async function withRole(req, fn) {
  const who = roleFor(req);
  if (who.error) throw Object.assign(new Error('JWT expired'), { code: 'PGRST301', status: 401 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${who.role}`);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(who.claims)]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function buildWhere(params, values, prefix = '') {
  const clauses = [];
  const cond = (col, opval) => {
    const dot = opval.indexOf('.');
    const op = opval.slice(0, dot);
    const val = opval.slice(dot + 1);
    const c = prefix + ident(col);
    switch (op) {
      case 'eq': values.push(val); return `${c} = $${values.length}`;
      case 'neq': values.push(val); return `${c} <> $${values.length}`;
      case 'gt': values.push(val); return `${c} > $${values.length}`;
      case 'gte': values.push(val); return `${c} >= $${values.length}`;
      case 'lt': values.push(val); return `${c} < $${values.length}`;
      case 'lte': values.push(val); return `${c} <= $${values.length}`;
      case 'ilike': values.push(val.replace(/\*/g, '%')); return `${c}::text ilike $${values.length}`;
      case 'is': return `${c} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : 'false'}`;
      default: throw Object.assign(new Error(`unsupported operator ${op}`), { code: 'PGRST100', status: 400 });
    }
  };
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue;
    if (k === 'or') {
      const inner = v.replace(/^\(/, '').replace(/\)$/, '');
      const parts = inner.split(',').map((part) => {
        const [col, ...rest] = part.split('.');
        return cond(col, rest.join('.'));
      });
      clauses.push(`(${parts.join(' or ')})`);
    } else {
      clauses.push(cond(k, v));
    }
  }
  return clauses.length ? `where ${clauses.join(' and ')}` : '';
}

function buildSelect(table, select) {
  const cols = (select ?? '*').split(',').map((s) => s.trim()).filter(Boolean);
  return cols
    .map((c) => {
      if (c === '*') return 't.*';
      const embed = /^([a-z_]+)\(count\)$/.exec(c);
      if (embed) {
        if (table === 'categories' && embed[1] === 'products') {
          return `(select json_build_array(json_build_object('count', count(*))) from public.products x where x.category_id = t.id) as products`;
        }
        throw Object.assign(new Error(`unsupported embed ${c}`), { code: 'PGRST200', status: 400 });
      }
      return `t.${ident(c)}`;
    })
    .join(', ');
}

function pgErrorStatus(e) {
  if (e.status) return e.status;
  if (e.code === '42501') return 403;
  if (e.code === '23505') return 409;
  if (e.code === 'P0002') return 404;
  return 400;
}

async function handleRest(req, res, url) {
  const p = url.pathname.replace('/rest/v1/', '');
  const wantsObject = (req.headers.accept ?? '').includes('application/vnd.pgrst.object+json');
  const prefer = req.headers.prefer ?? '';
  try {
    if (p.startsWith('rpc/')) {
      const fn = p.slice(4);
      ident(fn);
      const body = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      const result = await withRole(req, async (client) => {
        const meta = await client.query(
          `select p.proretset, t.typtype from pg_proc p join pg_type t on t.oid = p.prorettype
            where p.proname = $1 and p.pronamespace = 'public'::regnamespace`,
          [fn],
        );
        if (!meta.rowCount) throw Object.assign(new Error(`Could not find the function public.${fn}`), { code: 'PGRST202', status: 404 });
        const keys = Object.keys(body);
        const values = keys.map((k) => {
          const v = body[k];
          return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : Array.isArray(v) && v.some((x) => typeof x === 'object') ? JSON.stringify(v) : v;
        });
        const args = keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ');
        const { proretset, typtype } = meta.rows[0];
        if (proretset) return (await client.query(`select * from public.${ident(fn)}(${args})`, values)).rows;
        if (typtype === 'c') return (await client.query(`select * from public.${ident(fn)}(${args})`, values)).rows[0] ?? null;
        return (await client.query(`select public.${ident(fn)}(${args}) as v`, values)).rows[0].v;
      });
      return send(res, 200, result);
    }

    const table = p.split('/')[0];
    ident(table);
    const params = [...url.searchParams.entries()];

    if (req.method === 'GET' || req.method === 'HEAD') {
      const out = await withRole(req, async (client) => {
        const values = [];
        const where = buildWhere(params, values, 't.');
        const order = url.searchParams.get('order');
        const orderSql = order
          ? 'order by ' + order.split(',').map((o) => { const [c, dir] = o.split('.'); return `t.${ident(c)} ${dir === 'desc' ? 'desc' : 'asc'}`; }).join(', ')
          : '';
        const limit = url.searchParams.get('limit');
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const sql = `select ${buildSelect(table, url.searchParams.get('select'))} from public.${ident(table)} t ${where} ${orderSql} ${limit ? `limit ${Number(limit)}` : ''} offset ${offset}`;
        const rows = (await client.query(sql, values)).rows;
        let total = null;
        if (prefer.includes('count=exact')) {
          total = Number((await client.query(`select count(*) from public.${ident(table)} t ${where}`, values)).rows[0].count);
        }
        return { rows, total, offset };
      });
      const range = out.rows.length ? `${out.offset}-${out.offset + out.rows.length - 1}/${out.total ?? '*'}` : `*/${out.total ?? '*'}`;
      if (wantsObject) {
        if (out.rows.length !== 1) {
          return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${out.rows.length} rows`, hint: null });
        }
        return send(res, 200, out.rows[0], { 'Content-Range': range });
      }
      return send(res, 200, out.rows, { 'Content-Range': range });
    }

    if (req.method === 'POST' || req.method === 'PATCH') {
      const body = await readBody(req);
      const rows = await withRole(req, async (client) => {
        const values = [];
        if (req.method === 'POST') {
          const list = Array.isArray(body) ? body : [body];
          const cols = Object.keys(list[0]);
          const tuples = list.map((r) => `(${cols.map((c) => { values.push(r[c] !== null && typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c]); return `$${values.length}`; }).join(', ')})`);
          return (await client.query(`insert into public.${ident(table)} (${cols.map(ident).join(', ')}) values ${tuples.join(', ')} returning *`, values)).rows;
        }
        const sets = Object.keys(body).map((c) => { values.push(body[c] !== null && typeof body[c] === 'object' ? JSON.stringify(body[c]) : body[c]); return `${ident(c)} = $${values.length}`; });
        const where = buildWhere(params, values);
        return (await client.query(`update public.${ident(table)} set ${sets.join(', ')} ${where} returning *`, values)).rows;
      });
      const status = req.method === 'POST' ? 201 : 200;
      if (!prefer.includes('return=representation')) return send(res, status === 201 ? 201 : 204);
      if (wantsObject) {
        if (rows.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows`, hint: null });
        return send(res, status, rows[0]);
      }
      return send(res, status, rows);
    }

    if (req.method === 'DELETE') {
      await withRole(req, async (client) => {
        const values = [];
        await client.query(`delete from public.${ident(table)} ${buildWhere(params, values)}`, values);
      });
      return send(res, 204);
    }
    return send(res, 405, { message: 'method not allowed' });
  } catch (e) {
    return send(res, pgErrorStatus(e), { code: e.code ?? 'PGRST000', message: e.message, details: e.detail ?? null, hint: e.hint ?? null });
  }
}

// ---------------------------------------------------------------------------
// Edge Functions: load the real sources with a Deno shim
// ---------------------------------------------------------------------------
const handlers = {};
let loading = '';
globalThis.Deno = {
  env: {
    get: (k) =>
      ({ SUPABASE_URL: BASE, SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ALLOWED_ORIGINS: '*' })[k] ?? process.env[k],
  },
  serve: (handler) => {
    handlers[loading] = handler;
  },
};
const fnDir = path.resolve(import.meta.dirname, '../../supabase/functions');
for (const name of ['initial-setup', 'auth-login', 'admin-users', 'change-password']) {
  loading = name;
  await import(pathToFileURL(path.join(fnDir, name, 'index.ts')).href);
}

async function handleFunction(req, res, url) {
  const name = url.pathname.replace('/functions/v1/', '');
  const handler = handlers[name];
  if (!handler) return send(res, 404, { error: 'Function not found' });
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`${BASE}${url.pathname}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await handler(request);
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

// ---------------------------------------------------------------------------
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, BASE);
    try {
      if (req.method === 'OPTIONS' && !url.pathname.startsWith('/functions/')) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
          'Access-Control-Expose-Headers': 'Content-Range',
        });
        return res.end();
      }
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      if (url.pathname.startsWith('/auth/v1')) return await handleAuth(req, res, url);
      if (url.pathname.startsWith('/rest/v1/')) return await handleRest(req, res, url);
      if (url.pathname.startsWith('/functions/v1/')) return await handleFunction(req, res, url);
      if (url.pathname.startsWith('/realtime/')) return send(res, 404, {});
      return send(res, 404, { message: 'not found' });
    } catch (e) {
      console.error(e);
      return send(res, 500, { message: String(e?.message ?? e) });
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock supabase listening on ${BASE}`));
