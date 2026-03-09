import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { parse, serialize } from 'cookie';

export const COOKIE_NAME = 'startup_portal_session';

export function requireNonEmptyString(value, fieldName) {
    if (typeof value !== 'string' || !value.trim()) {
        const error = new Error(`${fieldName} is required`);
        error.status = 400;
        error.expose = true;
        throw error;
    }

    return value.trim();
}

export function normalizeEmail(email) {
    return email.trim().toLowerCase();
}

export async function hashPassword(password) {
    return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, passwordHash) {
    return bcrypt.compare(password, passwordHash);
}

export function createSessionToken() {
    return randomBytes(32).toString('hex');
}

export function hashSessionToken(token) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
        throw new Error('SESSION_SECRET is not configured');
    }

    return createHash('sha256').update(`${secret}:${token}`).digest('hex');
}

export function parseCookies(cookieHeader) {
    return parse(cookieHeader || '');
}

function isCookieSecure() {
    if (process.env.COOKIE_SECURE === 'true') {
        return true;
    }

    if (process.env.COOKIE_SECURE === 'false') {
        return false;
    }

    return process.env.NODE_ENV === 'production';
}

export function setSessionCookie(res, token, expiresAt) {
    res.setHeader('Set-Cookie', serialize(COOKIE_NAME, token, {
        httpOnly: true,
        secure: isCookieSecure(),
        sameSite: 'lax',
        path: '/',
        expires: expiresAt
    }));
}

export function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', serialize(COOKIE_NAME, '', {
        httpOnly: true,
        secure: isCookieSecure(),
        sameSite: 'lax',
        path: '/',
        expires: new Date(0)
    }));
}
