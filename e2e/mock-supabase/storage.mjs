// TEST-ONLY: subset of the Supabase Storage HTTP API used by INVPORTIQ
// (private buckets kept on disk). Every request needs the service-role key,
// like a private bucket without browser policies.
import path from 'node:path';
import { mkdir, readdir, readFile, writeFile, access, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const safeObjectPath = (p) => Boolean(p) && !p.split('/').some((seg) => seg === '..' || seg === '' || seg === '.');

export async function createStorage({ dir, serviceKey, send, readBody, bearer }) {
  await mkdir(path.join(dir, 'backups'), { recursive: true });

  return async function handleStorage(req, res, url) {
    if (bearer(req) !== serviceKey) {
      return send(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    }
    const p = decodeURIComponent(url.pathname.replace('/storage/v1/', ''));

    if (p === 'bucket' && req.method === 'GET') {
      const dirs = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory());
      return send(res, 200, dirs.map((d) => ({ id: d.name, name: d.name, public: false })));
    }

    if (p.startsWith('object/list/') && req.method === 'POST') {
      const bucket = p.slice('object/list/'.length);
      const body = await readBody(req);
      const prefix = body.prefix ?? '';
      let items = [];
      try {
        items = (await readdir(path.join(dir, bucket, prefix), { withFileTypes: true })).map((d) => ({
          name: d.name,
          id: d.isDirectory() ? null : `${bucket}/${prefix}/${d.name}`,
        }));
      } catch {
        items = [];
      }
      const offset = body.offset ?? 0;
      return send(res, 200, items.slice(offset, offset + (body.limit ?? 100)));
    }

    if (p.startsWith('object/')) {
      const [bucket, ...parts] = p.slice('object/'.length).split('/');
      const objectPath = parts.join('/');

      if (req.method === 'DELETE' && !objectPath) {
        const body = await readBody(req);
        for (const prefix of body.prefixes ?? []) {
          if (safeObjectPath(prefix)) await unlink(path.join(dir, bucket, prefix)).catch(() => {});
        }
        return send(res, 200, []);
      }
      if (!safeObjectPath(objectPath)) return send(res, 400, { message: 'Invalid key' });
      const file = path.join(dir, bucket, objectPath);

      if (req.method === 'GET') {
        try {
          const data = await readFile(file);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
          return res.end(data);
        } catch {
          return send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        }
      }

      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const upsert = req.headers['x-upsert'] === 'true' || req.method === 'PUT';
        const exists = await access(file).then(() => true, () => false);
        if (exists && !upsert) return send(res, 400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, Buffer.concat(chunks));
        return send(res, 200, { Key: `${bucket}/${objectPath}`, Id: randomUUID() });
      }
    }
    return send(res, 404, { message: 'not found' });
  };
}
