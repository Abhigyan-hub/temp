import fs from "node:fs";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { StorageNotFoundError } from "./local.js";

export function createS3Storage(config) {
  const bucket = config.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET is required for S3 storage");
  const client = new S3Client({
    region: config.S3_REGION || "auto",
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: Boolean(config.S3_FORCE_PATH_STYLE),
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY } }
      : {}),
  });
  const input = (Key) => ({ Bucket: bucket, Key });
  const isMissing = (err) => err?.name === "NoSuchKey" || err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404;

  return {
    driver: "s3",
    async put(key, sourcePath, { contentType } = {}) {
      await client.send(new PutObjectCommand({ ...input(key), Body: fs.createReadStream(sourcePath), ...(contentType ? { ContentType: contentType } : {}) }));
    },
    async getBuffer(key) {
      let result;
      try {
        result = await client.send(new GetObjectCommand(input(key)));
      } catch (err) {
        if (isMissing(err)) throw new Error("File not found in storage");
        throw err;
      }
      return Buffer.from(await result.Body.transformToByteArray());
    },
    async getStream(key) {
      try {
        const result = await client.send(new GetObjectCommand(input(key)));
        return result.Body;
      } catch (err) {
        if (isMissing(err)) throw new StorageNotFoundError();
        throw err;
      }
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand(input(key)));
        return true;
      } catch (err) {
        if (isMissing(err)) return false;
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand(input(key)));
    },
  };
}
