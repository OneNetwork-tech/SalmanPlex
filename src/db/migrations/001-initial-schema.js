'use strict';

const timestamps = (DataTypes) => ({
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
});

module.exports = {
  async up(qi, DataTypes) {
    await qi.createTable('users', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      username: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      email: { type: DataTypes.STRING(255), allowNull: true, unique: true },
      password_hash: { type: DataTypes.STRING(255), allowNull: false },
      role: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'viewer' },
      token_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      last_login_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps(DataTypes),
    });

    await qi.createTable('libraries', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(128), allowNull: false },
      type: { type: DataTypes.STRING(16), allowNull: false },
      path: { type: DataTypes.STRING(1024), allowNull: false, unique: true },
      scan_status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'idle' },
      scan_error: { type: DataTypes.TEXT, allowNull: true },
      last_scanned_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps(DataTypes),
    });

    await qi.createTable('media_items', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      library_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'libraries', key: 'id' },
        onDelete: 'CASCADE',
      },
      kind: { type: DataTypes.STRING(16), allowNull: false },
      title: { type: DataTypes.STRING(512), allowNull: false },
      sort_title: { type: DataTypes.STRING(512), allowNull: false },
      year: { type: DataTypes.INTEGER, allowNull: true },
      overview: { type: DataTypes.TEXT, allowNull: true },
      genres: { type: DataTypes.JSON, allowNull: true },
      poster_url: { type: DataTypes.STRING(1024), allowNull: true },
      backdrop_url: { type: DataTypes.STRING(1024), allowNull: true },
      tmdb_id: { type: DataTypes.INTEGER, allowNull: true },
      rating: { type: DataTypes.FLOAT, allowNull: true },
      series_title: { type: DataTypes.STRING(512), allowNull: true },
      season_number: { type: DataTypes.INTEGER, allowNull: true },
      episode_number: { type: DataTypes.INTEGER, allowNull: true },
      artist: { type: DataTypes.STRING(512), allowNull: true },
      album: { type: DataTypes.STRING(512), allowNull: true },
      track_number: { type: DataTypes.INTEGER, allowNull: true },
      relative_path: { type: DataTypes.STRING(2048), allowNull: false },
      file_size: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      file_mtime: { type: DataTypes.DATE, allowNull: true },
      mime_type: { type: DataTypes.STRING(128), allowNull: true },
      container: { type: DataTypes.STRING(64), allowNull: true },
      duration_seconds: { type: DataTypes.FLOAT, allowNull: true },
      width: { type: DataTypes.INTEGER, allowNull: true },
      height: { type: DataTypes.INTEGER, allowNull: true },
      video_codec: { type: DataTypes.STRING(64), allowNull: true },
      audio_codec: { type: DataTypes.STRING(64), allowNull: true },
      bitrate: { type: DataTypes.INTEGER, allowNull: true },
      subtitles: { type: DataTypes.JSON, allowNull: true },
      metadata_fetched_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps(DataTypes),
    });
    await qi.addIndex('media_items', ['library_id', 'relative_path'], { unique: true, name: 'media_items_library_path_uq' });
    await qi.addIndex('media_items', ['kind']);
    await qi.addIndex('media_items', ['series_title', 'season_number', 'episode_number']);
    await qi.addIndex('media_items', ['created_at']);

    await qi.createTable('watch_progress', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      media_item_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'media_items', key: 'id' },
        onDelete: 'CASCADE',
      },
      position_seconds: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      completed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      play_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      ...timestamps(DataTypes),
    });
    await qi.addIndex('watch_progress', ['user_id', 'media_item_id'], { unique: true, name: 'watch_progress_user_media_uq' });
    await qi.addIndex('watch_progress', ['user_id', 'updated_at']);

    await qi.createTable('favorites', {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      media_item_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'media_items', key: 'id' },
        onDelete: 'CASCADE',
      },
      ...timestamps(DataTypes),
    });
    await qi.addIndex('favorites', ['user_id', 'media_item_id'], { unique: true, name: 'favorites_user_media_uq' });
  },

  async down(qi) {
    await qi.dropTable('favorites');
    await qi.dropTable('watch_progress');
    await qi.dropTable('media_items');
    await qi.dropTable('libraries');
    await qi.dropTable('users');
  },
};
