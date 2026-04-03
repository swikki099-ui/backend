const crypto = require('crypto');

// A stable secret for encryption/decryption (fallback for local dev)
const SECRET = process.env.SESSION_SECRET || 'fallback-secure-secret-key-32-chars!@';
const algorithm = 'aes-256-cbc';
const key = crypto.scryptSync(SECRET, 'salt', 32);

module.exports = {
    encrypt: (data) => {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(algorithm, key, iv);
        let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return `${iv.toString('hex')}:${encrypted}`;
    },
    decrypt: (encryptedString) => {
        if (!encryptedString) return null;
        try {
            const [ivHex, encryptedHex] = encryptedString.split(':');
            const iv = Buffer.from(ivHex, 'hex');
            const decipher = crypto.createDecipheriv(algorithm, key, iv);
            let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return JSON.parse(decrypted);
        } catch (e) {
            return null;
        }
    }
};
