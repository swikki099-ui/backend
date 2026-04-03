require('dotenv').config();

const appConfig = {
    version: process.env.APP_VERSION,
    force: process.env.APP_FORCE,
    message: process.env.APP_MESSAGE,
    downloadUrl: process.env.APP_DOWNLOAD_URL
};

module.exports = appConfig;
