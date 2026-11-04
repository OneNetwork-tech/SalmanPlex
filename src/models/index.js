'use strict';

const { DataTypes } = require('sequelize');
const { sequelize } = require('../db');

const ROLES = ['admin', 'viewer'];
const LIBRARY_TYPES = ['movies', 'tv', 'music', 'photos'];
const MEDIA_KINDS = ['movie', 'episode', 'track', 'photo'];

const User = sequelize.define(
  'User',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    username: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    email: { type: DataTypes.STRING(255), allowNull: true, unique: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    role: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'viewer', validate: { isIn: [ROLES] } },
    tokenVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    lastLoginAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'users',
    defaultScope: { attributes: { exclude: ['passwordHash'] } },
    scopes: { withPassword: { attributes: { include: ['passwordHash'] } } },
  },
);

User.prototype.toJSON = function toJSON() {
  const { passwordHash, tokenVersion, ...rest } = this.get({ plain: true });
  return rest;
};

const Library = sequelize.define(
  'Library',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(128), allowNull: false },
    type: { type: DataTypes.STRING(16), allowNull: false, validate: { isIn: [LIBRARY_TYPES] } },
    path: { type: DataTypes.STRING(1024), allowNull: false, unique: true },
    scanStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'idle' },
    scanError: { type: DataTypes.TEXT, allowNull: true },
    lastScannedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: 'libraries' },
);

const MediaItem = sequelize.define(
  'MediaItem',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    libraryId: { type: DataTypes.INTEGER, allowNull: false },
    kind: { type: DataTypes.STRING(16), allowNull: false, validate: { isIn: [MEDIA_KINDS] } },
    title: { type: DataTypes.STRING(512), allowNull: false },
    sortTitle: { type: DataTypes.STRING(512), allowNull: false },
    year: { type: DataTypes.INTEGER, allowNull: true },
    overview: { type: DataTypes.TEXT, allowNull: true },
    genres: { type: DataTypes.JSON, allowNull: true },
    posterUrl: { type: DataTypes.STRING(1024), allowNull: true },
    backdropUrl: { type: DataTypes.STRING(1024), allowNull: true },
    tmdbId: { type: DataTypes.INTEGER, allowNull: true },
    rating: { type: DataTypes.FLOAT, allowNull: true },
    seriesTitle: { type: DataTypes.STRING(512), allowNull: true },
    seasonNumber: { type: DataTypes.INTEGER, allowNull: true },
    episodeNumber: { type: DataTypes.INTEGER, allowNull: true },
    artist: { type: DataTypes.STRING(512), allowNull: true },
    album: { type: DataTypes.STRING(512), allowNull: true },
    trackNumber: { type: DataTypes.INTEGER, allowNull: true },
    relativePath: { type: DataTypes.STRING(2048), allowNull: false },
    fileSize: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      // pg returns BIGINT as string; normalise to number (safe up to 9 PB).
      get() {
        const v = this.getDataValue('fileSize');
        return v === null || v === undefined ? v : Number(v);
      },
    },
    fileMtime: { type: DataTypes.DATE, allowNull: true },
    mimeType: { type: DataTypes.STRING(128), allowNull: true },
    container: { type: DataTypes.STRING(64), allowNull: true },
    durationSeconds: { type: DataTypes.FLOAT, allowNull: true },
    width: { type: DataTypes.INTEGER, allowNull: true },
    height: { type: DataTypes.INTEGER, allowNull: true },
    videoCodec: { type: DataTypes.STRING(64), allowNull: true },
    audioCodec: { type: DataTypes.STRING(64), allowNull: true },
    bitrate: { type: DataTypes.INTEGER, allowNull: true },
    subtitles: { type: DataTypes.JSON, allowNull: true },
    metadataFetchedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: 'media_items' },
);

const WatchProgress = sequelize.define(
  'WatchProgress',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    mediaItemId: { type: DataTypes.INTEGER, allowNull: false },
    positionSeconds: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
    completed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    playCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  },
  { tableName: 'watch_progress' },
);

const Favorite = sequelize.define(
  'Favorite',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.INTEGER, allowNull: false },
    mediaItemId: { type: DataTypes.INTEGER, allowNull: false },
  },
  { tableName: 'favorites' },
);

Library.hasMany(MediaItem, { foreignKey: 'libraryId', as: 'items', onDelete: 'CASCADE' });
MediaItem.belongsTo(Library, { foreignKey: 'libraryId', as: 'library' });

User.hasMany(WatchProgress, { foreignKey: 'userId', onDelete: 'CASCADE' });
MediaItem.hasMany(WatchProgress, { foreignKey: 'mediaItemId', as: 'progress', onDelete: 'CASCADE' });
WatchProgress.belongsTo(MediaItem, { foreignKey: 'mediaItemId', as: 'mediaItem' });
WatchProgress.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Favorite, { foreignKey: 'userId', onDelete: 'CASCADE' });
MediaItem.hasMany(Favorite, { foreignKey: 'mediaItemId', as: 'favorites', onDelete: 'CASCADE' });
Favorite.belongsTo(MediaItem, { foreignKey: 'mediaItemId', as: 'mediaItem' });

module.exports = {
  sequelize,
  User,
  Library,
  MediaItem,
  WatchProgress,
  Favorite,
  ROLES,
  LIBRARY_TYPES,
  MEDIA_KINDS,
};
