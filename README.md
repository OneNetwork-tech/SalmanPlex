# SalmanPlex

A Plex-like media server web application that allows users to upload, organize, and stream personal media content.

## Features

- Media library management (movies, TV shows, music, photos)
- Metadata fetching from TMDb and MusicBrainz
- On-demand streaming with adaptive bitrate
- User authentication and role-based access
- Responsive web interface
- Device compatibility (smart TVs, mobile apps, browsers)

## Tech Stack

- **Frontend**: React (planned)
- **Backend**: Node.js with Express
- **Database**: MongoDB
- **Media Handling**: FFmpeg (planned)
- **Authentication**: JWT (planned)
- **Storage**: Local file system
- **Metadata API**: TMDb, MusicBrainz (planned)
- **Streaming**: HLS (planned)

## Getting Started

### Prerequisites

- Docker
- Docker Compose
- Node.js (for local development)

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the application with Docker Compose:
   ```bash
   docker-compose up
   ```

### Development

To run the application in development mode with hot reloading:

```bash
npm run dev
```

### Testing

To run tests:
```bash
npm test
```

## API Endpoints

- `GET /` - API information
- `GET /health` - Health check
- `GET /api/media` - Get all media
- `GET /api/media/:id` - Get media by ID
- `POST /api/media` - Upload new media
- `DELETE /api/media/:id` - Delete media by ID

## Project Structure

```
.
├── src/
│   ├── controllers/
│   ├── routes/
│   └── server.js
├── docker-compose.yml
├── Dockerfile
├── k8s/
│   └── deployment.yaml
├── package.json
└── README.md
```

## Deployment

### With Docker

1. Build the Docker image:
   ```bash
   docker build -t salmanplex .
   ```

2. Run the container:
   ```bash
   docker run -p 3000:3000 salmanplex
   ```

### With Kubernetes

1. Apply the deployment:
   ```bash
   kubectl apply -f k8s/deployment.yaml
   ```

## License

This project is licensed under the MIT License.