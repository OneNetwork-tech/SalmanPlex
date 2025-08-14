// Media controller to handle media-related operations


// In-memory storage for media items
let mediaItems = [];
let nextId = 1;

const getAllMedia = (req, res) => {
  res.json({ 
    message: 'Successfully retrieved all media',
    data: mediaItems,
    count: mediaItems.length
  });
};

const getMediaById = (req, res) => {
  const { id } = req.params;
  const mediaId = parseInt(id);
  
  const mediaItem = mediaItems.find(item => item.id === mediaId);
  
  if (!mediaItem) {
    return res.status(404).json({ 
      message: `Media with ID: ${id} not found`,
      data: null
    });
  }
  
  res.json({ 
    message: `Successfully retrieved media with ID: ${id}`,
    data: mediaItem
  });
};

const uploadMedia = (req, res) => {
  const { title, description, type, filePath } = req.body;
  
  // Basic validation
  if (!title || !type) {
    return res.status(400).json({
      message: 'Title and type are required',
      data: null
    });
  }
  
  const newMedia = {
    id: nextId++,
    title,
    description: description || '',
    type, // 'movie', 'series', 'music', etc.
    filePath: filePath || '',
    uploadDate: new Date().toISOString(),
    metadata: {}
  };
  
  mediaItems.push(newMedia);
  
  res.status(201).json({ 
    message: 'Media uploaded successfully',
    data: newMedia
  });
};

const deleteMedia = (req, res) => {
  const { id } = req.params;
  const mediaId = parseInt(id);
  
  const mediaIndex = mediaItems.findIndex(item => item.id === mediaId);
  
  if (mediaIndex === -1) {
    return res.status(404).json({ 
      message: `Media with ID: ${id} not found`,
      data: null
    });
  }
  
  const deletedMedia = mediaItems.splice(mediaIndex, 1);
  
  res.json({ 
    message: `Successfully deleted media with ID: ${id}`,
    data: deletedMedia[0]
  });
};

module.exports = {
  getAllMedia,
  getMediaById,
  uploadMedia,
  deleteMedia
};