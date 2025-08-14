const express = require('express');
const router = express.Router();
const mediaController = require('../controllers/mediaController');

// Media routes
router.get('/', mediaController.getAllMedia);
router.get('/:id', mediaController.getMediaById);
router.post('/', mediaController.uploadMedia);
router.delete('/:id', mediaController.deleteMedia);

module.exports = router;