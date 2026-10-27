# Hearth encrypted-home architecture

## Current source-code boundary

`server.js` is the API engine. It owns request routing and never exposes the encrypted data directories as static web assets.

`lib/secure-store.js` is the encrypted data layer. It uses AES-256-GCM with authenticated encryption for:

- `data/household.enc` — records database: members, assets, dates and metadata.
- `data/documents/` — original scans and uploaded files.

The app creates a persistent local development key with owner-only file permissions. A production launch must provide `HEARTH_MASTER_KEY` as a base64-encoded 32-byte secret; the server deliberately refuses to start in production without it.

## Service mapping

| Architecture service | Current implementation | Production evolution |
| --- | --- | --- |
| API engine | `server.js` routes and private document delivery | authenticated gateway, audit log, rate limits |
| Ingestion service | `storeUpload`, OCR, metadata extraction | isolated worker queue, malware scan, durable jobs |
| Records database | encrypted local document | PostgreSQL with per-household access controls |
| Document store | encrypted local files | encrypted object storage with envelope keys |
| AI search service | document metadata/query endpoint foundation | permission-filtered RAG plus `pgvector` |
| Reminders engine | due-date fields in records | scheduled worker and notification delivery |

## Security rules for deployment

1. Keep `HEARTH_MASTER_KEY` in a secrets manager, never in source control.
2. Replace the development key with a managed KMS key and per-household data keys.
3. Add real user authentication and server-enforced household-role checks before exposing the server beyond the home network.
4. Keep scans private: serve them only through an authorized API route; never from a public uploads folder.
5. Use TLS for every device-to-server connection and log document access.

The local encrypted-store implementation protects data at rest. It is not a replacement for authentication, authorization, KMS, backups, or secure network deployment.

## Private local LLM and RAG

Hearth now has a local RAG API designed for an Ollama-compatible server running on the home server:

- `GET /api/ai/status` checks configuration.
- `POST /api/ai/reindex` embeds OCR text and metadata into the encrypted `ragIndex` record.
- `POST /api/ai/ask` retrieves the most relevant encrypted vector entries and asks the local model to answer with source citations.

Set these only on the home server process:

```sh
export LOCAL_LLM_URL=http://127.0.0.1:11434
export LOCAL_LLM_MODEL=<your-local-chat-model>
export LOCAL_EMBEDDING_MODEL=<your-local-embedding-model>
```

The source code makes no cloud-AI call. In production, add authentication and role-filtering before each retrieval so a child can only retrieve records they are allowed to see.

## Document-intake agent

`POST /api/agent/document-intake` is a review-first local agent. It runs OCR on the submitted scan, then asks the local model to propose the document type, family-member match, metadata, missing fields, and a confidence score. The browser fills those suggestions into the upload form but does not save or move a record until the user reviews the result and saves it again. If the local model is unavailable, private OCR rules provide a clearly labelled lower-confidence fallback.
