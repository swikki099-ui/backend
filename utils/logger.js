const util = require('util');

const MAX_LOGS = 2000;
const logs = [];

// Store original console methods
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

/**
 * Capture logs into an in-memory buffer
 */
function captureLog(type, args) {
    const message = util.format.apply(null, args);
    const timestamp = new Date();
    
    logs.unshift({ timestamp, type, message }); // prepend for newest first
    
    // Maintain maximum buffer size
    if (logs.length > MAX_LOGS) {
        logs.pop();
    }
}

// Override console.log
console.log = function() {
    captureLog('INFO', arguments);
    originalLog.apply(console, arguments);
};

// Override console.error
console.error = function() {
    captureLog('ERROR', arguments);
    originalError.apply(console, arguments);
};

// Override console.warn
console.warn = function() {
    captureLog('WARN', arguments);
    originalWarn.apply(console, arguments);
};

// Override console.info
console.info = function() {
    captureLog('INFO', arguments);
    originalInfo.apply(console, arguments);
};

module.exports = {
    getLogs: () => logs,
    clearLogs: () => { logs.length = 0; }
};
