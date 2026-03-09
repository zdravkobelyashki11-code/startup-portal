import { Pool } from 'pg';

let pool;
let initPromise;

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS teams (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        team_name TEXT NOT NULL,
        team_idea TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
        id UUID PRIMARY KEY,
        team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS threads (
        id UUID PRIMARY KEY,
        team_id UUID NOT NULL UNIQUE REFERENCES teams(id) ON DELETE CASCADE,
        summary_md TEXT NOT NULL DEFAULT '',
        last_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        last_compacted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY,
        thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content_md TEXT NOT NULL,
        attachment_name TEXT,
        attachment_mime TEXT,
        compacted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    'CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions(token_hash)',
    'CREATE INDEX IF NOT EXISTS sessions_team_id_idx ON sessions(team_id)',
    'CREATE INDEX IF NOT EXISTS messages_thread_created_idx ON messages(thread_id, created_at)',
    'CREATE INDEX IF NOT EXISTS messages_thread_compacted_created_idx ON messages(thread_id, compacted_at, created_at)'
];

function getPool() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is not configured');
    }

    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
        });
    }

    return pool;
}

export async function ensureDatabaseReady() {
    if (!initPromise) {
        initPromise = (async () => {
            const db = getPool();
            const client = await db.connect();
            try {
                for (const statement of SCHEMA_STATEMENTS) {
                    await client.query(statement);
                }
            } finally {
                client.release();
            }
        })().catch((error) => {
            initPromise = null;
            throw error;
        });
    }

    return initPromise;
}

export async function query(text, params = []) {
    await ensureDatabaseReady();
    return getPool().query(text, params);
}

export async function withTransaction(callback) {
    await ensureDatabaseReady();
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
