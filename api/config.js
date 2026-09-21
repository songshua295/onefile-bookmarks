const { getType } = require('./lib/storage');
const { enabled: authEnabled } = require('./lib/auth');
const fs = require('fs');

module.exports = (req, res) => {
  const localFile = process.env.BOOKMARK_FILE || 'favorites_2026_9_20.html';
  res.status(200).json({
    storageType: getType(),
    uploadMode: (process.env.UPLOAD_MODE || 'overwrite').toLowerCase(),
    autoUpload: (process.env.AUTO_UPLOAD || 'false') === 'true',
    aiEnabled: !!(process.env.AI_API_KEY && process.env.AI_BASE_URL),
    needAuth: authEnabled(),
    localFile: fs.existsSync(localFile) ? localFile : null
  });
};
