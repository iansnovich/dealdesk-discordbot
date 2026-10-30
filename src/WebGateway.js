// The bot's web routes are only reachable through a reverse proxy (for example a
// Cloudflare Worker) that adds a shared secret header. Direct hits get a 404.
const crypto = require('node:crypto');

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const GATEWAY_KEY = process.env.GATEWAY_KEY || '';

function fromGateway(req) {
    if (!GATEWAY_KEY) return false;
    const given = Buffer.from(String(req.headers['x-gateway-key'] || ''));
    const want = Buffer.from(GATEWAY_KEY);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
}

module.exports = { PUBLIC_URL, fromGateway };
