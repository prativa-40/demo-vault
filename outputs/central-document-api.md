# Hearth Central Document API

The Hearth web application is the central source of truth. Mobile apps keep only an encrypted cache; they upload and retrieve files through this API.

Base URL: `https://vault.example.com/api/v1`

## Authentication

Use a short-lived household access token on every request:

```http
Authorization: Bearer <access-token>
```

The server must derive the household and the caller's role from the token. Never accept a household ID supplied by the client.

## Upload a document

`POST /documents`

The current implementation accepts JSON with a base64 data URL. A production deployment can put the file fields behind a multipart or pre-signed-upload adapter without changing the response model.

```json
{
  "owner": { "kind": "member", "id": "member-id" },
  "document": {
    "type": "Aadhaar",
    "documentName": "Aarav Kapoor",
    "number": "0000 1111 2222",
    "documentDate": "1981-04-18",
    "address": "42 Demo Lane, Bengaluru"
  },
  "file": {
    "name": "aarav_aadhaar.pdf",
    "dataUrl": "data:application/pdf;base64,..."
  }
}
```

Response: `201 Created`

```json
{
  "id": "document-id",
  "owner": { "kind": "member", "id": "member-id", "name": "Aarav Kapoor" },
  "type": "Aadhaar",
  "status": "Review needed",
  "ocrStatus": "Read locally - review details",
  "contentUrl": "/api/v1/documents/document-id/content"
}
```

## Search and retrieve metadata

`GET /documents?ownerKind=member&ownerId=member-id&type=Aadhaar&q=aarav`

Returns document metadata only. Supported filters are `ownerKind`, `ownerId`, `type`, and `q`.

`GET /documents/{documentId}`

Returns a single metadata record, including a central `contentUrl`.

## Retrieve a scan

`GET /documents/{documentId}/content`

Returns the original file with `Content-Disposition: inline`. Mobile apps should cache this encrypted at rest and revalidate metadata before showing it.

## Access rules

- Head of household: upload, update, delete, and retrieve all household documents.
- Homemaker: upload, update, delete, and retrieve documents, but cannot add family members.
- Child: can retrieve only their own document metadata and file content.

Production requirements: HTTPS, authenticated role checks on every route, encrypted object storage, malware scanning, audit events, short-lived download URLs or authenticated streaming, and rate limits. The local prototype exposes the same route shapes but does not yet have production authentication.
