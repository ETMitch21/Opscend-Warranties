import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try {
  const root=resolve(process.cwd(),'sql');
  const scripts=readdirSync(root).filter(n=>/^\d+_.*\.sql$/.test(n)).sort();
  const client=await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)',[4781802]);
    await client.query('CREATE TABLE IF NOT EXISTS warranty_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    for(const name of scripts) {
      const r=await client.query('SELECT 1 FROM warranty_migrations WHERE filename=$1',[name]);
      if(r.rowCount) continue;
      await client.query('BEGIN');
      try {await client.query(readFileSync(resolve(root,name),'utf8')); await client.query('INSERT INTO warranty_migrations(filename) VALUES($1)',[name]); await client.query('COMMIT'); process.stdout.write(`Applied ${name}\n`);}
      catch(e){await client.query('ROLLBACK');throw e;}
    }
  } finally {await client.query('SELECT pg_advisory_unlock($1)',[4781802]);client.release();}
} finally {await pool.end();}
