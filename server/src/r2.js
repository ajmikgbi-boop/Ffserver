'use strict';

const crypto = require('node:crypto');
const {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function cleanEtag(etag) {
  return typeof etag === 'string' ? etag.replace(/"/g, '') : '';
}

function isNotFound(err) {
  const status = err && err.$metadata && err.$metadata.httpStatusCode;
  return status === 404 || (err && (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.Code === 'NoSuchKey'));
}

function lowercaseKeys(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) out[key.toLowerCase()] = value;
  return out;
}

function metadataHeaders(metadata) {
  const headers = {};
  for (const [key, value] of Object.entries(metadata)) headers[`x-amz-meta-${key.toLowerCase()}`] = String(value);
  return headers;
}

/**
 * Thin wrapper around the S3 API of Cloudflare R2.
 *
 * The server never proxies file bytes: uploads and downloads go straight from the
 * desktop app to R2 through short-lived presigned URLs, so memory use stays flat
 * no matter how large the files are.
 */
class R2Storage {
  constructor({ endpoint, accessKeyId, secretAccessKey, bucket, presignExpiresSeconds }) {
    this.bucket = bucket;
    this.expiresIn = presignExpiresSeconds;
    this.client = new S3Client({
      region: 'auto',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      // Newer AWS SDK versions add CRC32 checksums to every request by default, which
      // breaks presigned PUT URLs (the checksum of an empty body gets signed in).
      // R2's documentation recommends only sending checksums when required.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 4,
    });
  }

  /** List every object below `prefix` (handles pagination). */
  async listAll(prefix) {
    const objects = [];
    let token;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
      );
      for (const item of res.Contents || []) {
        objects.push({
          key: item.Key,
          size: Number(item.Size || 0),
          etag: cleanEtag(item.ETag),
          lastModified: item.LastModified ? new Date(item.LastModified).getTime() : Date.now(),
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return objects;
  }

  /** HEAD an object. Returns null when it does not exist. */
  async head(key) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: Number(res.ContentLength || 0),
        etag: cleanEtag(res.ETag),
        lastModified: res.LastModified ? new Date(res.LastModified).getTime() : Date.now(),
        metadata: lowercaseKeys(res.Metadata),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Read and parse a JSON object. Returns null when it does not exist. */
  async getJson(key) {
    let text;
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      text = await res.Body.transformToString('utf8');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    return JSON.parse(text);
  }

  async putJson(key, value) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: 'application/json',
        CacheControl: 'no-store',
      }),
    );
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Server-side copy (no bytes pass through this server). Returns the new ETag. */
  async copy(sourceKey, destKey, metadata) {
    const res = await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destKey,
        CopySource: `${this.bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
        MetadataDirective: 'REPLACE',
        Metadata: metadata,
      }),
    );
    return cleanEtag(res.CopyObjectResult && res.CopyObjectResult.ETag);
  }

  /** Stream an object through SHA-256 without buffering it (used for objects uploaded outside the app). */
  async sha256Of(key) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const hash = crypto.createHash('sha256');
    for await (const chunk of res.Body) hash.update(chunk);
    return hash.digest('hex');
  }

  /**
   * Presigned PUT. Metadata is signed as *headers* (not hoisted into the query string),
   * so the client must send exactly the returned headers. This guarantees the uploaded
   * object carries x-amz-meta-sha256.
   */
  async presignPut(key, metadata) {
    const headers = metadataHeaders(metadata);
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Metadata: metadata }),
      { expiresIn: this.expiresIn, unhoistableHeaders: new Set(Object.keys(headers)) },
    );
    return { url, headers, expiresIn: this.expiresIn };
  }

  async presignGet(key) {
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: this.expiresIn,
    });
    return { url, expiresIn: this.expiresIn };
  }

  async createMultipart(key, metadata) {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, Metadata: metadata }),
    );
    return res.UploadId;
  }

  async presignPart(key, uploadId, partNumber) {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: this.expiresIn },
    );
  }

  async completeMultipart(key, uploadId, parts) {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipart(key, uploadId) {
    try {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

module.exports = { R2Storage, isNotFound };
