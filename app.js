import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import {
    clearSessionCookie,
    COOKIE_NAME,
    createSessionToken,
    hashSessionToken,
    normalizeEmail,
    parseCookies,
    requireNonEmptyString,
    setSessionCookie,
    verifyPassword,
    hashPassword
} from './lib/auth.js';
import { ensureDatabaseReady, query, withTransaction } from './lib/db.js';
import {
    buildCompactionPrompt,
    buildImagePromptText,
    buildMentorPrompt
} from './lib/mentor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.2';
const SESSION_TTL_DAYS = 14;
const COMPACTION_THRESHOLD = 100000;
const RETAIN_RECENT_MESSAGES = 12;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
let openaiClient;
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES }
});

class AppError extends Error {
    constructor(status, message, options = {}) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.expose = options.expose ?? status < 500;
        this.code = options.code;
    }
}

const asyncHandler = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
};

function getAllowedOrigin(origin) {
    if (!origin) {
        return true;
    }

    const appOrigin = process.env.APP_ORIGIN;
    if (appOrigin && origin === appOrigin) {
        return true;
    }

    if (process.env.NODE_ENV !== 'production') {
        return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    }

    return false;
}

const corsMiddleware = cors({
    origin(origin, callback) {
        if (getAllowedOrigin(origin)) {
            return callback(null, true);
        }

        return callback(new AppError(403, 'Origin not allowed'));
    },
    credentials: true
});

app.use(corsMiddleware);
app.options('*', corsMiddleware);
app.use(express.json({ limit: '4mb' }));
app.use(express.static(join(__dirname, 'public')));

function mapOpenAIError(error) {
    if (error instanceof AppError) {
        return error;
    }

    if (error?.status === 401 || error?.status === 403) {
        return new AppError(502, 'Upstream AI authentication failed', { expose: false });
    }

    if (error?.status === 429) {
        return new AppError(503, 'The AI service is temporarily unavailable');
    }

    if (error?.status >= 400 && error?.status < 500) {
        return new AppError(502, error.message || 'Upstream AI request failed');
    }

    return new AppError(502, 'The AI service is temporarily unavailable');
}

function getOpenAIClient() {
    if (!process.env.OPENAI_API_KEY) {
        throw new AppError(500, 'OPENAI_API_KEY is not configured', { expose: false });
    }

    if (!openaiClient) {
        openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    return openaiClient;
}

function extractAssistantText(messageContent) {
    if (typeof messageContent === 'string') {
        return messageContent;
    }

    if (Array.isArray(messageContent)) {
        return messageContent
            .filter((item) => item?.type === 'text' && item.text)
            .map((item) => item.text)
            .join('\n')
            .trim();
    }

    return '';
}

function sanitizeTeam(teamRow) {
    return {
        id: teamRow.id,
        email: teamRow.email,
        teamName: teamRow.team_name,
        teamIdea: teamRow.team_idea,
        createdAt: teamRow.created_at
    };
}

function assertValidEmail(email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new AppError(400, 'A valid email is required');
    }
}

const requireAuth = asyncHandler(async (req, res, next) => {
    await ensureDatabaseReady();

    const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    if (!token) {
        throw new AppError(401, 'Authentication required');
    }

    const tokenHash = hashSessionToken(token);
    const { rows } = await query(
        `SELECT s.id AS session_id,
                s.expires_at,
                t.id,
                t.email,
                t.team_name,
                t.team_idea,
                t.created_at
           FROM sessions s
           JOIN teams t ON t.id = s.team_id
          WHERE s.token_hash = $1
            AND s.expires_at > NOW()`,
        [tokenHash]
    );

    const session = rows[0];
    if (!session) {
        clearSessionCookie(res);
        throw new AppError(401, 'Authentication required');
    }

    await query('UPDATE sessions SET last_seen_at = NOW() WHERE id = $1', [session.session_id]);

    req.auth = {
        sessionId: session.session_id,
        team: sanitizeTeam(session)
    };
    next();
});

function buildSessionExpiry() {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_TTL_DAYS);
    return expiresAt;
}

async function createSession(teamId) {
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);
    const expiresAt = buildSessionExpiry();

    await query(
        `INSERT INTO sessions (id, team_id, token_hash, expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [randomUUID(), teamId, tokenHash, expiresAt]
    );

    return { token, expiresAt };
}

async function getOrCreateThread(teamId) {
    const existing = await query(
        `SELECT id, team_id, summary_md, last_prompt_tokens, last_compacted_at, created_at, updated_at
           FROM threads
          WHERE team_id = $1`,
        [teamId]
    );

    if (existing.rows[0]) {
        return existing.rows[0];
    }

    const created = await query(
        `INSERT INTO threads (id, team_id)
         VALUES ($1, $2)
         RETURNING id, team_id, summary_md, last_prompt_tokens, last_compacted_at, created_at, updated_at`,
        [randomUUID(), teamId]
    );

    return created.rows[0];
}

async function getActiveMessages(threadId) {
    const { rows } = await query(
        `SELECT id, role, content_md, attachment_name, attachment_mime, created_at
           FROM messages
          WHERE thread_id = $1
            AND compacted_at IS NULL
          ORDER BY created_at ASC, id ASC`,
        [threadId]
    );

    return rows;
}

async function getThreadHistory(teamId) {
    const thread = await getOrCreateThread(teamId);
    const messages = await getActiveMessages(thread.id);

    return {
        thread,
        messages
    };
}

function formatMessageForResponse(messageRow) {
    return {
        id: messageRow.id,
        role: messageRow.role,
        content: messageRow.content_md,
        attachmentName: messageRow.attachment_name,
        attachmentMime: messageRow.attachment_mime,
        createdAt: messageRow.created_at
    };
}

function toOpenAIMessages(messages) {
    return messages.map((message) => ({
        role: message.role,
        content: message.content_md
    }));
}

async function insertMessage(threadId, role, content, attachment = {}) {
    const { rows } = await query(
        `INSERT INTO messages (id, thread_id, role, content_md, attachment_name, attachment_mime)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, role, content_md, attachment_name, attachment_mime, created_at`,
        [
            randomUUID(),
            threadId,
            role,
            content,
            attachment.attachmentName || null,
            attachment.attachmentMime || null
        ]
    );

    return rows[0];
}

function extractLatestTextMessage(body) {
    if (typeof body?.message === 'string' && body.message.trim()) {
        return body.message.trim();
    }

    if (typeof body?.userMessage === 'string' && body.userMessage.trim()) {
        return body.userMessage.trim();
    }

    if (Array.isArray(body?.messages)) {
        for (let index = body.messages.length - 1; index >= 0; index -= 1) {
            const message = body.messages[index];
            if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) {
                return message.content.trim();
            }
        }
    }

    return '';
}

async function compactThreadIfNeeded(threadId, team, promptTokens) {
    await query('UPDATE threads SET last_prompt_tokens = $1, updated_at = NOW() WHERE id = $2', [
        promptTokens,
        threadId
    ]);

    if (!promptTokens || promptTokens <= COMPACTION_THRESHOLD) {
        return;
    }

    const { rows } = await query(
        `SELECT id, summary_md
           FROM threads
          WHERE id = $1`,
        [threadId]
    );
    const thread = rows[0];
    if (!thread) {
        return;
    }

    const activeMessages = await getActiveMessages(threadId);
    if (activeMessages.length <= RETAIN_RECENT_MESSAGES) {
        return;
    }

    const messagesToCompact = activeMessages.slice(0, -RETAIN_RECENT_MESSAGES);
    if (!messagesToCompact.length) {
        return;
    }

    const completion = await getOpenAIClient().chat.completions.create({
        model: MODEL,
        messages: [
            {
                role: 'developer',
                content: buildCompactionPrompt(team, thread.summary_md, messagesToCompact)
            }
        ],
        max_completion_tokens: 1200,
        temperature: 0.2
    });
    const summary = extractAssistantText(completion.choices[0]?.message?.content);
    if (!summary) {
        throw new AppError(502, 'Compaction returned an empty summary');
    }

    const ids = messagesToCompact.map((message) => message.id);
    await withTransaction(async (client) => {
        await client.query(
            `UPDATE threads
                SET summary_md = $1,
                    last_compacted_at = NOW(),
                    updated_at = NOW()
              WHERE id = $2`,
            [summary, threadId]
        );
        await client.query(
            `UPDATE messages
                SET compacted_at = NOW()
              WHERE id = ANY($1::uuid[])
                AND compacted_at IS NULL`,
            [ids]
        );
    });
}

async function createChatCompletion(team, threadId, currentMessages, latestMessage) {
    const client = getOpenAIClient();
    const threadState = await query('SELECT summary_md FROM threads WHERE id = $1', [threadId]);
    const summaryMd = threadState.rows[0]?.summary_md || '';

    const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
            {
                role: 'developer',
                content: buildMentorPrompt(team, summaryMd)
            },
            ...toOpenAIMessages(currentMessages),
            latestMessage
        ],
        max_completion_tokens: 3000,
        temperature: 0.7
    });

    const reply = extractAssistantText(completion.choices[0]?.message?.content);
    if (!reply) {
        throw new AppError(502, 'The AI returned an empty response');
    }

    return { completion, reply };
}

app.get('/api/health', asyncHandler(async (req, res) => {
    let databaseReady = false;

    if (process.env.DATABASE_URL) {
        try {
            await ensureDatabaseReady();
            databaseReady = true;
        } catch (error) {
            databaseReady = false;
        }
    }

    res.json({
        status: 'ok',
        model: MODEL,
        hasApiKey: Boolean(process.env.OPENAI_API_KEY),
        databaseConfigured: Boolean(process.env.DATABASE_URL),
        databaseReady,
        authConfigured: Boolean(process.env.SESSION_SECRET)
    });
}));

app.post('/api/auth/register', asyncHandler(async (req, res) => {
    await ensureDatabaseReady();

    const email = normalizeEmail(requireNonEmptyString(req.body?.email, 'email'));
    assertValidEmail(email);
    const password = requireNonEmptyString(req.body?.password, 'password');
    const teamName = requireNonEmptyString(req.body?.teamName, 'teamName');
    const teamIdea = typeof req.body?.teamIdea === 'string' ? req.body.teamIdea.trim() : '';

    if (password.length < 8) {
        throw new AppError(400, 'Password must be at least 8 characters');
    }

    const passwordHash = await hashPassword(password);
    let team;
    try {
        const result = await withTransaction(async (client) => {
            const createdTeam = await client.query(
                `INSERT INTO teams (id, email, password_hash, team_name, team_idea)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, email, team_name, team_idea, created_at`,
                [randomUUID(), email, passwordHash, teamName, teamIdea || null]
            );

            await client.query(
                `INSERT INTO threads (id, team_id)
                 VALUES ($1, $2)`,
                [randomUUID(), createdTeam.rows[0].id]
            );

            return createdTeam.rows[0];
        });

        team = result;
    } catch (error) {
        if (error?.code === '23505') {
            throw new AppError(409, 'An account with that email already exists');
        }
        throw error;
    }

    const session = await createSession(team.id);
    setSessionCookie(res, session.token, session.expiresAt);

    res.status(201).json({
        team: sanitizeTeam(team)
    });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
    await ensureDatabaseReady();

    const email = normalizeEmail(requireNonEmptyString(req.body?.email, 'email'));
    assertValidEmail(email);
    const password = requireNonEmptyString(req.body?.password, 'password');

    const { rows } = await query(
        `SELECT id, email, password_hash, team_name, team_idea, created_at
           FROM teams
          WHERE email = $1`,
        [email]
    );
    const team = rows[0];

    if (!team || !(await verifyPassword(password, team.password_hash))) {
        throw new AppError(401, 'Invalid email or password');
    }

    await getOrCreateThread(team.id);
    const session = await createSession(team.id);
    setSessionCookie(res, session.token, session.expiresAt);

    res.json({
        team: sanitizeTeam(team)
    });
}));

app.post('/api/auth/logout', asyncHandler(async (req, res) => {
    await ensureDatabaseReady();

    const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
    if (token) {
        await query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)]);
    }

    clearSessionCookie(res);
    res.status(204).send();
}));

app.get('/api/auth/me', requireAuth, asyncHandler(async (req, res) => {
    res.json({
        team: req.auth.team
    });
}));

app.get('/api/history', requireAuth, asyncHandler(async (req, res) => {
    const { thread, messages } = await getThreadHistory(req.auth.team.id);

    res.json({
        team: req.auth.team,
        thread: {
            id: thread.id,
            summary: thread.summary_md || '',
            lastPromptTokens: thread.last_prompt_tokens || 0,
            lastCompactedAt: thread.last_compacted_at
        },
        messages: messages.map(formatMessageForResponse)
    });
}));

app.post('/api/chat', requireAuth, asyncHandler(async (req, res) => {
    const userMessage = extractLatestTextMessage(req.body);
    if (!userMessage) {
        throw new AppError(400, 'A user message is required');
    }

    const { thread, messages } = await getThreadHistory(req.auth.team.id);
    await insertMessage(thread.id, 'user', userMessage);

    const latestMessage = { role: 'user', content: userMessage };
    let completionResult;
    try {
        completionResult = await createChatCompletion(req.auth.team, thread.id, messages, latestMessage);
    } catch (error) {
        throw mapOpenAIError(error);
    }

    const assistantMessage = await insertMessage(thread.id, 'assistant', completionResult.reply);
    const promptTokens = completionResult.completion.usage?.prompt_tokens || 0;

    try {
        await compactThreadIfNeeded(thread.id, req.auth.team, promptTokens);
    } catch (error) {
        console.error('Compaction error:', error);
    }

    res.json({
        reply: completionResult.reply,
        model: completionResult.completion.model,
        usage: completionResult.completion.usage,
        message: formatMessageForResponse(assistantMessage)
    });
}));

app.post('/api/chat/image', requireAuth, upload.single('image'), asyncHandler(async (req, res) => {
    if (!req.file) {
        throw new AppError(400, 'No image file uploaded');
    }

    const userPrompt = buildImagePromptText(req.body?.userMessage, req.file.originalname);
    const { thread, messages } = await getThreadHistory(req.auth.team.id);

    await insertMessage(thread.id, 'user', userPrompt, {
        attachmentName: req.file.originalname,
        attachmentMime: req.file.mimetype
    });

    const base64Image = req.file.buffer.toString('base64');
    const imageMessage = {
        role: 'user',
        content: [
            {
                type: 'image_url',
                image_url: { url: `data:${req.file.mimetype};base64,${base64Image}` }
            },
            {
                type: 'text',
                text: userPrompt
            }
        ]
    };

    let completionResult;
    try {
        completionResult = await createChatCompletion(req.auth.team, thread.id, messages, imageMessage);
    } catch (error) {
        throw mapOpenAIError(error);
    }

    const assistantMessage = await insertMessage(thread.id, 'assistant', completionResult.reply);
    const promptTokens = completionResult.completion.usage?.prompt_tokens || 0;

    try {
        await compactThreadIfNeeded(thread.id, req.auth.team, promptTokens);
    } catch (error) {
        console.error('Compaction error:', error);
    }

    res.json({
        reply: completionResult.reply,
        model: completionResult.completion.model,
        usage: completionResult.completion.usage,
        message: formatMessageForResponse(assistantMessage)
    });
}));

app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
            error: `Image uploads are limited to ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB`
        });
    }

    const mappedError = error instanceof AppError
        ? error
        : error?.status
            ? new AppError(error.status, error.message || 'Request failed', {
                expose: error.expose ?? error.status < 500
            })
            : error;
    const status = mappedError?.status || 500;
    const message = mappedError?.expose === false ? 'Internal server error' : mappedError?.message || 'Internal server error';

    if (status >= 500) {
        console.error(error);
    }

    res.status(status).json({
        error: message
    });
});

export default app;
