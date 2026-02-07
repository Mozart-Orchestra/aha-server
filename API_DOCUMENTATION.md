# Aha Server API Documentation

**Version:** 1.0.0
**Base URL:** `http://localhost:3005` (development) or `https://top1vibe.com` (production)
**Documentation:** `http://localhost:3005/docs` (Swagger UI)

---

## Table of Contents

1. [Authentication](#authentication)
2. [Sessions](#sessions)
3. [Machines](#machines)
4. [Artifacts](#artifacts)
5. [Push Notifications](#push-notifications)
6. [Connect (AI Keys)](#connect-ai-keys)
7. [Account](#account)
8. [Access Keys](#access-keys)
9. [Voice](#voice)
10. [User](#user)
11. [Feed](#feed)
12. [Key-Value Storage](#key-value-storage)
13. [Team Messages](#team-messages)
14. [Development](#development)

---

## Authentication

Most endpoints require Bearer token authentication. Include your token in the Authorization header:

```http
Authorization: Bearer YOUR_TOKEN_HERE
```

### POST /v1/auth

Authenticate with Ed25519 signature challenge.

**Request Body:**
```json
{
  "publicKey": "base64-encoded-public-key",
  "challenge": "base64-encoded-challenge",
  "signature": "base64-encoded-signature"
}
```

**Response (200):**
```json
{
  "success": true,
  "token": "jwt-token-here"
}
```

**Error (401):**
```json
{
  "error": "Invalid signature"
}
```

---

### POST /v1/auth/request

Request terminal authentication (for CLI without browser).

**Request Body:**
```json
{
  "publicKey": "base64-encoded-public-key",
  "supportsV2": true
}
```

**Response (200) - Pending:**
```json
{
  "state": "requested"
}
```

**Response (200) - Authorized:**
```json
{
  "state": "authorized",
  "token": "jwt-token-here",
  "response": "response-data"
}
```

---

### GET /v1/auth/request/status

Check authentication request status.

**Query Parameters:**
- `publicKey` (string, required): Base64-encoded public key

**Response (200):**
```json
{
  "status": "pending" | "authorized"
}
```

---

## Sessions

### POST /v1/sessions

Create a new Claude Code session.

**Request Body:**
```json
{
  "metadata": {
    "startedBy": "daemon" | "terminal",
    "mode": "local" | "remote",
    "sessionTag": "optional-tag"
  }
}
```

**Response (200):**
```json
{
  "id": "session-id",
  "createdAt": "2024-01-19T10:00:00Z",
  "metadata": {...}
}
```

---

### GET /v1/sessions/:id

Get session details.

**Response (200):**
```json
{
  "id": "session-id",
  "createdAt": "2024-01-19T10:00:00Z",
  "updatedAt": "2024-01-19T11:00:00Z",
  "messages": [...],
  "artifacts": [...]
}
```

---

### PATCH /v1/sessions/:id

Update session metadata.

**Request Body:**
```json
{
  "metadata": {
    "title": "Session title",
    "tags": ["tag1", "tag2"]
  }
}
```

---

### DELETE /v1/sessions/:id

Delete a session.

**Response (200):**
```json
{
  "success": true
}
```

---

## Machines

### POST /v1/machines

Register a new machine.

**Request Body:**
```json
{
  "machineId": "unique-machine-id",
  "hostname": "machine-hostname",
  "platform": "darwin" | "linux" | "win32",
  "arch": "x64" | "arm64",
  "nodeVersion": "v20.0.0"
}
```

**Response (200):**
```json
{
  "id": "machine-id",
  "registeredAt": "2024-01-19T10:00:00Z"
}
```

---

### POST /v1/machines/:id/heartbeat

Send machine heartbeat to keep alive.

**Request Body:**
```json
{
  "status": "active" | "idle",
  "sessions": ["session-id-1", "session-id-2"]
}
```

---

### GET /v1/machines

List all registered machines for current user.

**Response (200):**
```json
{
  "machines": [
    {
      "id": "machine-id",
      "hostname": "machine-hostname",
      "lastSeen": "2024-01-19T10:00:00Z",
      "status": "online"
    }
  ]
}
```

---

## Artifacts

### POST /v1/artifacts

Upload a session artifact.

**Request:** Multipart form data

**Form Fields:**
- `sessionId` (string, required): Session ID
- `type` (string, required): Artifact type (e.g., "image", "file", "code")
- `content` (file, required): Artifact file
- `metadata` (string, optional): JSON metadata

**Response (200):**
```json
{
  "id": "artifact-id",
  "url": "https://s3.amazonaws.com/...",
  "type": "image",
  "createdAt": "2024-01-19T10:00:00Z"
}
```

---

### GET /v1/artifacts/:id

Get artifact metadata.

**Response (200):**
```json
{
  "id": "artifact-id",
  "sessionId": "session-id",
  "type": "image",
  "url": "https://s3.amazonaws.com/...",
  "metadata": {...}
}
```

---

### GET /v1/sessions/:id/artifacts

List all artifacts for a session.

**Response (200):**
```json
{
  "artifacts": [
    {
      "id": "artifact-id-1",
      "type": "image",
      "createdAt": "2024-01-19T10:00:00Z"
    }
  ]
}
```

---

## Push Notifications

### POST /v1/push/send

Send push notification to all user devices.

**Request Body:**
```json
{
  "title": "Notification title",
  "message": "Notification message",
  "data": {
    "source": "cli",
    "timestamp": 1705680000000
  }
}
```

**Response (200):**
```json
{
  "success": true,
  "delivered": 3
}
```

---

### POST /v1/push/register

Register push notification token.

**Request Body:**
```json
{
  "token": "expo-push-token",
  "platform": "ios" | "android"
}
```

---

## Connect (AI Keys)

### GET /v1/connect

List all connected AI vendor API keys.

**Response (200):**
```json
{
  "keys": [
    {
      "id": "key-id",
      "vendor": "anthropic" | "openai" | "google",
      "masked": "sk-ant-...xxxx"
    }
  ]
}
```

---

### POST /v1/connect

Add a new AI vendor API key.

**Request Body:**
```json
{
  "vendor": "anthropic",
  "apiKey": "sk-ant-api03-..."
}
```

**Response (200):**
```json
{
  "id": "key-id",
  "vendor": "anthropic",
  "masked": "sk-ant-...xxxx"
}
```

---

### DELETE /v1/connect/:id

Remove an API key.

**Response (200):**
```json
{
  "success": true
}
```

---

## Account

### GET /v1/account

Get current account information.

**Response (200):**
```json
{
  "id": "account-id",
  "publicKey": "hex-encoded-public-key",
  "createdAt": "2024-01-19T10:00:00Z",
  "settings": {...}
}
```

---

### PATCH /v1/account

Update account settings.

**Request Body:**
```json
{
  "settings": {
    "theme": "dark",
    "notifications": true
  }
}
```

---

## Access Keys

### POST /v1/access-keys

Create a new access key.

**Request Body:**
```json
{
  "name": "My Access Key",
  "expiresAt": "2024-02-19T10:00:00Z"
}
```

**Response (200):**
```json
{
  "id": "key-id",
  "key": "hk-live-xxxxx",
  "name": "My Access Key",
  "createdAt": "2024-01-19T10:00:00Z"
}
```

---

### GET /v1/access-keys

List all access keys.

**Response (200):**
```json
{
  "keys": [
    {
      "id": "key-id",
      "name": "My Access Key",
      "createdAt": "2024-01-19T10:00:00Z",
      "lastUsed": "2024-01-19T11:00:00Z"
    }
  ]
}
```

---

### DELETE /v1/access-keys/:id

Revoke an access key.

**Response (200):**
```json
{
  "success": true
}
```

---

## Voice

### POST /v1/voice/text-to-speech

Convert text to speech using ElevenLabs.

**Request Body:**
```json
{
  "text": "Hello, world!",
  "voiceId": "voice-id"
}
```

**Response (200):** Audio file (audio/mpeg)

---

## User

### GET /v1/user/me

Get current user profile.

**Response (200):**
```json
{
  "id": "user-id",
  "email": "user@example.com",
  "createdAt": "2024-01-19T10:00:00Z"
}
```

---

### PATCH /v1/user/me

Update user profile.

**Request Body:**
```json
{
  "email": "newemail@example.com"
}
```

---

## Feed

### GET /v1/feed

Get activity feed.

**Query Parameters:**
- `limit` (number, optional): Number of items (default: 20)
- `offset` (number, optional): Pagination offset

**Response (200):**
```json
{
  "items": [
    {
      "id": "item-id",
      "type": "session_created" | "artifact_added",
      "timestamp": "2024-01-19T10:00:00Z",
      "data": {...}
    }
  ],
  "hasMore": false
}
```

---

## Key-Value Storage

### GET /v1/k/:key

Get value by key.

**Response (200):**
```json
{
  "key": "my-key",
  "value": "my-value"
}
```

---

### PUT /v1/k/:key

Set key-value pair.

**Request Body:**
```json
{
  "value": "my-value"
}
```

---

### DELETE /v1/k/:key

Delete key-value pair.

**Response (200):**
```json
{
  "success": true
}
```

---

## Team Messages

### POST /v1/team-messages

Send a message to team collaboration room.

**Request Body:**
```json
{
  "roomId": "room-id",
  "content": "Message content",
  "type": "chat" | "notification",
  "mentions": ["user-id-1"]
}
```

---

### GET /v1/team-messages/:roomId

Get messages from a room.

**Query Parameters:**
- `limit` (number, optional): Number of messages
- `before` (string, optional): Get messages before this message ID

**Response (200):**
```json
{
  "messages": [
    {
      "id": "msg-id",
      "senderId": "user-id",
      "content": "Message content",
      "timestamp": "2024-01-19T10:00:00Z"
    }
  ]
}
```

---

## Development

### GET /health

Health check endpoint.

**Response (200):**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-19T10:00:00Z"
}
```

---

### GET /metrics

Prometheus metrics endpoint.

**Response (200):** Plain text metrics

---

### GET /ping

Simple ping endpoint.

**Response (200):**
```
pong
```

---

## WebSocket Connection

Connect to WebSocket at `/socket.io/` for real-time updates:

```javascript
const socket = io('http://localhost:3005', {
  auth: { token: 'YOUR_TOKEN' }
});

// Listen for session updates
socket.on('session:update', (data) => {
  console.log('Session updated:', data);
});

// Listen for new messages
socket.on('message:new', (data) => {
  console.log('New message:', data);
});
```

**Events:**
- `session:update`: Session updated
- `session:delete`: Session deleted
- `artifact:add`: Artifact added
- `message:new`: New message received
- `machine:heartbeat`: Machine heartbeat

---

## Error Codes

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 400 | Bad Request |
| 401 | Unauthorized - Invalid or missing token |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found |
| 429 | Rate Limit Exceeded |
| 500 | Internal Server Error |

**Error Response Format:**
```json
{
  "error": "Error message description"
}
```

---

## Rate Limiting

Default rate limits:
- **100 requests** per **15 minutes** per IP
- Custom limits per endpoint may apply

**Rate Limit Response (429):**
```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 60
}
```

---

## SDK Examples

### JavaScript/TypeScript

```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3005',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

// Create session
const session = await api.post('/v1/sessions', {
  metadata: { startedBy: 'terminal' }
});

// Get artifacts
const artifacts = await api.get(`/v1/sessions/${sessionId}/artifacts`);
```

### Python

```python
import requests

headers = {'Authorization': f'Bearer {token}'}

# Create session
session = requests.post(
    'http://localhost:3005/v1/sessions',
    json={'metadata': {'startedBy': 'terminal'}},
    headers=headers
).json()

# Get artifacts
artifacts = requests.get(
    f'http://localhost:3005/v1/sessions/{session["id"]}/artifacts',
    headers=headers
).json()
```

---

**Last Updated:** 2024-01-19
**API Version:** 1.0.0
**Documentation Version:** 1.0.0

---

*Generated with [Claude Code](https://claude.ai/code) via [Aha](https://aha.engineering)*
*Co-Authored-By: Claude <noreply@anthropic.com>*
*Co-Authored-By: Aha <yesreply@aha.engineering>*
